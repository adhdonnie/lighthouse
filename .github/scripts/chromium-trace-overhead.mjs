/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Compare the IDs-only trace patch with the unmodified browser, using fixed frame work.
// This is a bounded diagnostic measurement, not a universal performance guarantee.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';

import puppeteer from 'puppeteer-core';
import {launch} from 'chrome-launcher';

const [patched, control, directory] = process.argv.slice(2);
const output = path.resolve(directory);
await fs.mkdir(output, {recursive: true});
const smokeOnly = process.argv.includes('--validate-control');
const frames = smokeOnly ? 10 : 300;
const warmup = smokeOnly ? 3 : 60;
const order = smokeOnly ? 'CC' : 'PCCPPCCP';
const results = [];
const html = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<style>body{margin:0}#box{width:60px;height:60px;background:#245;' +
  'will-change:transform}</style>' +
  '<div id="box"></div>';
await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify({
  patched, control, smokeOnly, frames, warmup, order,
  traceModes: smokeOnly ? [true] : [false, true],
  method: 'Fresh profiles. Fixed rAF transform updates. SystemInfo.getProcessInfo cumulative ' +
    'CPU seconds before/after frame work and trace stop. No score or acceptance threshold.',
}, null, 2));

function delta(before, after) {
  const old = new Map(before.processInfo.map(info => [info.id, info.cpuTime]));
  return after.processInfo.reduce((sum, info) => sum + info.cpuTime - (old.get(info.id) || 0), 0);
}

for (const tracing of (smokeOnly ? [true] : [false, true])) {
  for (const [index, arm] of [...order].entries()) {
    const run = `${tracing ? 'trace' : 'off'}-${index + 1}-${arm}`;
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'lh-overhead-'));
    const row = {run, arm, tracing, frames};
    let chrome;
    let browser;
    let timer;
    try {
      chrome = await launch({chromePath: arm === 'P' ? patched : control,
        userDataDir: profile, port: 0, logLevel: 'silent', chromeFlags: ['--headless=new']});
      row.processArgs = chrome.process.spawnargs;
      browser = await puppeteer.connect({browserURL: `http://127.0.0.1:${chrome.port}`});
      const root = await browser.target().createCDPSession();
      const [page] = await browser.pages();
      await page.setViewport({width: 412, height: 823, deviceScaleFactor: 1.75,
        isMobile: true, hasTouch: true});
      await page.setContent(html);
      const animate = async count => {
        return page.evaluate(n => new Promise(resolve => {
          const {document, requestAnimationFrame} = globalThis;
          const box = document.getElementById('box');
          let done = 0;
          const times = [];
          const tick = ts => {
            box.style.transform = `translateX(${done % 300}px)`;
            times.push(ts);
            if (++done === n) resolve(times);
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }), count);
      };
      await animate(warmup);
      if (tracing) await page.tracing.start({categories: ['-*', 'viz']});
      const before = await root.send('SystemInfo.getProcessInfo');
      const started = performance.now();
      const timestamps = await Promise.race([animate(frames), new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Frame work exceeded 60 seconds')), 60000);
      })]);
      clearTimeout(timer);
      row.wallMs = performance.now() - started;
      row.frameIntervalsMs = timestamps.slice(1).map((ts, i) => ts - timestamps[i]);
      const after = await root.send('SystemInfo.getProcessInfo');
      row.cpuSecondsDuringFrames = delta(before, after);
      row.processCpu = {before, after};
      if (tracing) {
        const stop = performance.now();
        const bytes = await page.tracing.stop();
        row.traceStopMs = performance.now() - stop;
        row.traceBytes = bytes.length;
        const events = JSON.parse(Buffer.from(bytes).toString()).traceEvents;
        const decisions = events.filter(event => event.name === 'SendBeginFrameDecision');
        assert(decisions.length > 0, 'The viz measurement must record decision events');
        row.decisionEvents = decisions.length;
        row.counterStateEvents = events
          .filter(event => event.name === 'BeginFrameUndrawnState').length;
        assert.equal(row.counterStateEvents, 0,
          'Measure only the IDs patch, not extra counter events');
        const withIds = decisions.filter(event =>
          Number.isInteger(event.args.frame_sink_client_id) &&
          Number.isInteger(event.args.frame_sink_sink_id)).length;
        assert.equal(withIds, arm === 'P' ? decisions.length : 0, 'Wrong browser variant');
        row.decisionsWithIds = withIds;
        row.addedDecisionJsonBytes = decisions.reduce((sum, event) => {
          const {frame_sink_client_id: client, frame_sink_sink_id: sink, ...withoutIds} =
            event.args;
          if (client === undefined || sink === undefined) return sum;
          return sum + Buffer.byteLength(JSON.stringify(event.args)) -
            Buffer.byteLength(JSON.stringify(withoutIds));
        }, 0);
        await fs.writeFile(path.join(output, `${run}.trace.json.gz`), gzipSync(bytes));
      }
      const afterStop = await root.send('SystemInfo.getProcessInfo');
      row.cpuSecondsIncludingTraceStop = delta(before, afterStop);
    } catch (error) {
      row.error = {message: error.message, stack: error.stack};
    } finally {
      clearTimeout(timer);
      if (browser) await browser.disconnect();
      if (chrome) await chrome.kill();
      await fs.rm(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
      results.push(row);
      await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
      console.log(JSON.stringify({run, wallMs: row.wallMs, cpu: row.cpuSecondsDuringFrames,
        error: row.error?.message}));
    }
  }
}
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const groups = [];
for (const tracing of (smokeOnly ? [true] : [false, true])) {
  for (const arm of (smokeOnly ? ['C'] : ['P', 'C'])) {
    const rows = results.filter(row => row.tracing === tracing && row.arm === arm && !row.error);
    groups.push({tracing, arm, samples: rows.length,
      wallMsMedian: median(rows.map(row => row.wallMs)),
      cpuSecondsDuringFramesMedian: median(rows.map(row => row.cpuSecondsDuringFrames)),
      cpuSecondsIncludingTraceStopMedian: median(rows.map(row => row.cpuSecondsIncludingTraceStop)),
      addedDecisionJsonBytes: rows.reduce((sum, row) =>
        sum + (row.addedDecisionJsonBytes || 0), 0)});
  }
}
await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify({smokeOnly, groups,
  limitation: 'Small controlled compositor workload; snapshots may omit exited processes. ' +
    'JSON argument bytes are not Perfetto wire bytes. No universal overhead acceptance claim.',
}, null, 2));
if (results.some(row => row.error)) process.exitCode = 1;
