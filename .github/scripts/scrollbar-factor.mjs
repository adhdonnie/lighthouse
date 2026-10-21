/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Usage: CHROME_PATH=... node scrollbar-factor.mjs /path/to/lighthouse /path/to/output
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
const order = process.env.SCROLLBAR_ORDER || 'VHHVVH';
assert(/^[VH]+$/.test(order));
const settings = {
  onlyCategories: ['performance'], formFactor: 'mobile', throttlingMethod: 'simulate',
  additionalTraceCategories: 'cc,viz,renderer.scheduler,disabled-by-default-cc.debug,' +
    'disabled-by-default-devtools.timeline.frame,disabled-by-default-cc.debug.scheduler,' +
    'disabled-by-default-viz.surface_id_flow',
};
await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify({
  order, settings, url, sourceFiles: await Promise.all(['core/lib/tracehouse/trace-processor.js',
    'core/lib/network-recorder.js', 'core/gather/gatherers/console-messages.js']
    .map(async file => ({file, sha256: hash(await fs.readFile(path.join(root, file)))}))),
  fixture: {htmlSha256: hash(html), cssSha256: hash(css)},
  hypothesis: 'Only scrollbar visibility changes, with a matched CDP command before normal ' +
    'mobile metrics. RenderDocument remains disabled. Document 200ms/CSS 100ms. ' +
    'Diagnostic; not equivalent mobile scoring.',
}, null, 2));
const results = [];
try {
  for (const [index, arm] of [...order].entries()) {
    visibility = arm; commands = [];
    activeRun = `${index + 1}-${arm}`;
    const row = {run: activeRun, arm};
    DEFAULT_FLAGS.splice(0, DEFAULT_FLAGS.length, ...defaults);
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
      row.auditErrors = Object.values(result.lhr.audits).filter(audit =>
        audit.scoreDisplayMode === 'error')
        .map(audit => ({id: audit.id, error: audit.errorMessage}));
      row.scrollbarCommands = commands;
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
  ProtocolSession.prototype.sendCommand = originalSend;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
if (results.some(row => row.error || row.runtimeError || row.auditErrors?.length)) {
  process.exitCode = 1;
}
