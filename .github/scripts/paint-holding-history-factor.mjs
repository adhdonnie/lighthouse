/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Usage: CHROME_PATH=... node paint-holding-history-factor.mjs /path/to/lighthouse /path/to/output
// A matched scrollbar intervention, never a production site optimization or equivalent mobile score.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const root = path.resolve(process.argv[2]);
const load = relative => import(pathToFileURL(path.join(root, relative)).href);
const {default: lighthouse} = await load('core/index.js');
const {launch} = await load('node_modules/chrome-launcher/dist/index.js');
const {DEFAULT_FLAGS} = await load('node_modules/chrome-launcher/dist/flags.js');
const {ProtocolSession} = await load('core/gather/session.js');
const originalSend = ProtocolSession.prototype.sendCommand;
let visibility;
let commands = [];
ProtocolSession.prototype.sendCommand = async function(method, ...params) {
  if (method === 'Emulation.setDeviceMetricsOverride') {
    const sent = {hidden: visibility === 'H'};
    await originalSend.call(this, 'Emulation.setScrollbarsHidden', sent);
    commands.push({method: 'Emulation.setScrollbarsHidden', params: sent,
      beforeMetrics: params[0]});
  }
  return originalSend.call(this, method, ...params);
};

const output = path.resolve(process.argv[3]);
assert(process.env.CHROME_PATH, 'CHROME_PATH must select the built diagnostic browser');
await fs.mkdir(output, {recursive: true});
const html = '<!doctype html><html><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Plain rendering fixture</title><link rel="stylesheet" href="/blocking.css">' +
  '</head><body><h1>Plain rendering fixture</h1>' +
  Array.from({length: 1200}, (_, i) =>
    `<div><p>Static paragraph ${i} for controlled rendering.</p>` +
    '<a href="#top">Static link</a></div>').join('') + '</body></html>';
const css = 'body{margin:24px;background:#fff;color:#111;font:16px system-ui}' +
  'div{padding:2px}a{color:#245}';
const hash = text => createHash('sha256').update(text).digest('hex');
const requests = [];
let activeRun;
const server = http.createServer((req, res) => {
  const body = req.url === '/about' ? html : req.url === '/blocking.css' ? css : '';
  const started = performance.now();
  setTimeout(() => {
    if (res.destroyed) return;
    res.writeHead(body ? 200 : 404, {
      'content-type': req.url === '/about' ? 'text/html; charset=utf-8' : 'text/css',
      'cache-control': 'no-store', 'content-length': Buffer.byteLength(body),
    });
    res.end(body);
    requests.push({run: activeRun, url: req.url, bytes: Buffer.byteLength(body),
      sha256: hash(body), delayMs: performance.now() - started});
  }, req.url === '/about' ? 200 : req.url === '/blocking.css' ? 100 : 0);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/about`;
const defaults = [...DEFAULT_FLAGS];
assert(defaults.some(flag => flag.includes('RenderDocument')),
  'Default must disable RenderDocument');
const limitOrder = 'FTTFFT';
const order = 'VVVVVV';
const fadeMode = process.env.HISTORY_FADE_MODE;
assert(['normalized', 'amplified'].includes(fadeMode), 'Explicit fade mode is required');
const fadeDelayFactor = fadeMode === 'normalized' ? '1.0' : '0.1';
const fadeDurationFactor = fadeMode === 'normalized' ? '1.0' : '10.0';
const fadeFeature = 'ScaleScrollbarAnimationTiming:' +
  `fade_delay_scaling_factor/${fadeDelayFactor}/fade_duration_scaling_factor/${fadeDurationFactor}`;
assert(/^[VH]+$/.test(order));
const settings = {
  onlyCategories: ['performance'], formFactor: 'mobile', throttlingMethod: 'simulate',
  additionalTraceCategories: 'cc,viz,renderer.scheduler,disabled-by-default-cc.debug,' +
    'disabled-by-default-devtools.timeline.frame,disabled-by-default-cc.debug.scheduler,' +
    'disabled-by-default-viz.surface_id_flow',
};
await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify({
  order, limitOrder, fadeMode, fadeDelayFactor, fadeDurationFactor, fadeFeature, settings, url,
  candidateRevision: 'c80d80e1ebd09d057d5c96e84807df539504e7c0',
  sourceFiles: await Promise.all(['core/lib/tracehouse/trace-processor.js',
    'core/lib/network-recorder.js', 'core/gather/gatherers/console-messages.js']
    .map(async file => ({file, sha256: hash(await fs.readFile(path.join(root, file)))}))),
  fixture: {htmlSha256: hash(html), cssSha256: hash(css)},
  hypothesis: 'Only LimitCrossOriginNonActivatedPaintHolding changes in FTTFFT order. ' +
    'Fixed --test-type=gpu suppresses CfT infobar in every arm. ' +
    'Scrollbars remain visible, device metrics and declared fade timing identical across arms. ' +
    'Mobile metrics. RenderDocument remains disabled. Document 200ms/CSS 100ms. ' +
    'Diagnostic; not equivalent mobile scoring.',
}, null, 2));
function describeFailure(error, depth = 0) {
  if (error === null || typeof error !== 'object') return error;
  const result = {};
  for (const key of ['name', 'message', 'stack', 'code', 'errno', 'syscall', 'address', 'port']) {
    if (error[key] !== undefined) result[key] = error[key];
  }
  if (error.cause !== undefined && depth < 5) {
    result.cause = describeFailure(error.cause, depth + 1);
  }
  if (Array.isArray(error.errors) && depth < 5) {
    result.errors = error.errors.map(item => describeFailure(item, depth + 1));
  }
  return result;
}
const results = [];
try {
  for (const [index, arm] of [...order].entries()) {
    visibility = arm; commands = [];
    activeRun = `${index + 1}-${arm}`;
    const row = {run: activeRun, arm, limitCrossOriginPaintHolding: limitOrder[index] === 'T'};
    const armDefaults = defaults.map(flag => flag.startsWith('--disable-features=') &&
      !row.limitCrossOriginPaintHolding ?
        flag + ',LimitCrossOriginNonActivatedPaintHolding' : flag);
    DEFAULT_FLAGS.splice(0, DEFAULT_FLAGS.length, ...armDefaults);
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'lh-sink-'));
    let chrome;
    const browserExitEvents = [];
    let timeout;
    try {
      chrome = await launch({chromePath: process.env.CHROME_PATH, userDataDir: profile,
        chromeFlags: ['--headless=new', '--test-type=gpu',
          '--enable-features=' + ['DevToolsWebMCPSupport',
            'LimitCrossOriginNonActivatedPaintHolding', fadeFeature].join(',')],
        port: 0, logLevel: 'silent'});
      chrome.process.on('exit', (code, signal) => {
        browserExitEvents.push({code, signal, wallTime: new Date().toISOString()});
      });
      row.processArgs = chrome.process.spawnargs;
      row.version = await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json();
      const result = await Promise.race([
        lighthouse(url, {port: chrome.port, logLevel: 'error', output: 'json'},
          {extends: 'lighthouse:default', settings}),
        new Promise((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Collection exceeded 120 seconds')), 120000);
        }),
      ]);
      // Preserve returned evidence even when an old protocol causes a runtime error.
      await fs.writeFile(path.join(output, `${activeRun}.lhr.json`), JSON.stringify(result.lhr));
      for (const [key, suffix] of [['Trace', 'trace'], ['DevtoolsLog', 'devtoolslog']]) {
        if (result.artifacts?.[key] !== undefined) {
          await fs.writeFile(path.join(output, `${activeRun}.${suffix}.json.gz`),
            gzipSync(JSON.stringify(result.artifacts[key])));
        } else {
          (row.missingArtifacts ||= []).push(key);
        }
      }
      row.runtimeError = result.lhr.runtimeError;
      row.auditErrors = Object.values(result.lhr.audits).filter(audit =>
        audit.scoreDisplayMode === 'error')
        .map(audit => ({id: audit.id, error: audit.errorMessage}));
      row.scrollbarCommands = commands;
      row.metrics = result.lhr.audits.metrics?.details?.items?.[0];
    } catch (error) {
      row.error = describeFailure(error);
    } finally {
      clearTimeout(timeout);
      // Capture natural exit status before cleanup can introduce a signal.
      if (chrome) {
        row.browserBeforeCleanup = {pid: chrome.process.pid,
          exitCode: chrome.process.exitCode, signalCode: chrome.process.signalCode,
          killed: chrome.process.killed, observedExitEvents: [...browserExitEvents]};
      }
      for (const name of ['chrome-out.log', 'chrome-err.log']) {
        try {
          await fs.copyFile(path.join(profile, name), path.join(output, `${activeRun}.${name}`));
        } catch (error) {
          (row.browserLogCopyErrors ||= []).push({name, error: describeFailure(error)});
        }
      }
      if (chrome) await chrome.kill();
      await fs.rm(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
      results.push(row);
      await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
      await fs.writeFile(path.join(output, 'requests.json'), JSON.stringify(requests, null, 2));
      console.log(JSON.stringify(row));
    }
  }
} finally {
  DEFAULT_FLAGS.splice(0, DEFAULT_FLAGS.length, ...defaults);
  ProtocolSession.prototype.sendCommand = originalSend;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
if (results.some(row => row.error || row.runtimeError || row.auditErrors?.length)) {
  process.exitCode = 1;
}
