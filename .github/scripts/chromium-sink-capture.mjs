/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Diagnostic captures only: these do not establish scheduler causality or tracing overhead.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import assert from 'node:assert/strict';

import {launch} from 'chrome-launcher';
import {DEFAULT_FLAGS} from 'chrome-launcher/dist/flags.js';

import lighthouse from '../../core/index.js';

const output = path.resolve(process.argv[2]);
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
  }, body ? 200 : 0);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/about`;
const defaults = [...DEFAULT_FLAGS];
const restored = defaults.map(flag => flag.startsWith('--disable-features=') ?
  '--disable-features=' + flag.slice('--disable-features='.length).split(',')
    .filter(feature => feature !== 'RenderDocument').join(',') : flag);
assert.notDeepEqual(defaults, restored);
const settings = {
  onlyCategories: ['performance'], formFactor: 'mobile', throttlingMethod: 'simulate',
  additionalTraceCategories: 'cc,viz,renderer.scheduler,disabled-by-default-cc.debug,' +
    'disabled-by-default-devtools.timeline.frame',
};
await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify({
  order: 'ABBAAB', settings, url, fixture: {htmlSha256: hash(html), cssSha256: hash(css)},
  hypothesis: 'B removes only RenderDocument disablement; browser default decides activation.',
}, null, 2));
const results = [];
try {
  for (const [index, arm] of [...'ABBAAB'].entries()) {
    activeRun = `${index + 1}-${arm}`;
    const row = {run: activeRun, arm};
    DEFAULT_FLAGS.splice(0, DEFAULT_FLAGS.length, ...(arm === 'A' ? defaults : restored));
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'lh-sink-'));
    let chrome;
    let timeout;
    try {
      chrome = await launch({chromePath: process.env.CHROME_PATH, userDataDir: profile,
        chromeFlags: ['--headless=new', '--enable-features=DevToolsWebMCPSupport'],
        port: 0, logLevel: 'silent'});
      row.processArgs = chrome.process.spawnargs;
      row.version = await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json();
      const result = await Promise.race([
        lighthouse(url, {port: chrome.port, logLevel: 'error', output: 'json'},
          {extends: 'lighthouse:default', settings}),
        new Promise((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Collection exceeded 120 seconds')), 120000);
        }),
      ]);
      row.runtimeError = result.lhr.runtimeError;
      row.metrics = result.lhr.audits.metrics.details.items[0];
      await fs.writeFile(path.join(output, `${activeRun}.lhr.json`), JSON.stringify(result.lhr));
      await fs.writeFile(path.join(output, `${activeRun}.trace.json.gz`),
        gzipSync(JSON.stringify(result.artifacts.Trace)));
      await fs.writeFile(path.join(output, `${activeRun}.devtoolslog.json.gz`),
        gzipSync(JSON.stringify(result.artifacts.DevtoolsLog)));
    } catch (error) {
      row.error = {message: error.message, stack: error.stack};
    } finally {
      clearTimeout(timeout);
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
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
if (results.some(row => row.error || row.runtimeError)) process.exitCode = 1;
