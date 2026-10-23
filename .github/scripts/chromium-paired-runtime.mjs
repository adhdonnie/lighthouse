/** SPDX-License-Identifier: Apache-2.0 */
// Usage: node chromium-paired-runtime.mjs LIGHTHOUSE_ROOT BASELINE_CHROME FIXED_CHROME OUTPUT
// No score threshold or automatic causal verdict. Both binaries retain security policy.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
const [rootArg, baselineArg, fixedArg, outputArg] = process.argv.slice(2);
assert(rootArg && baselineArg && fixedArg && outputArg, 'Four explicit paths required');
const root = path.resolve(rootArg);
const variants = {A: path.resolve(baselineArg), B: path.resolve(fixedArg)};
const output = path.resolve(outputArg);
const diagnosticMode = process.env.CHROMIUM_DIAGNOSTIC_MODE || 'instrumented';
assert(['instrumented', 'without-added-diagnostics'].includes(diagnosticMode),
  'Unknown diagnostic mode');
const chromiumRevision = process.env.CHROMIUM_REVISION ||
  '0e66b94549a8bd85f03fbdf189b752d6e7b63c32';
const chromiumVersion = process.env.CHROMIUM_VERSION || '155.0.8059.85';
assert.match(chromiumRevision, /^[a-f0-9]{40}$/, 'Require an exact Chromium revision');
assert.match(chromiumVersion, /^\d+\.\d+\.\d+\.\d+$/, 'Require an exact Chromium version');
const hash = value => createHash('sha256').update(value).digest('hex');
const load = relative => import(pathToFileURL(path.join(root, relative)).href);
const requireFromRoot = createRequire(path.join(root, 'package.json'));
const {default: puppeteer} = await import(pathToFileURL(requireFromRoot.resolve('puppeteer-core')));
const {default: lighthouse} = await load('core/index.js');
const {launch} = await load('node_modules/chrome-launcher/dist/index.js');
const {DEFAULT_FLAGS} = await load('node_modules/chrome-launcher/dist/flags.js');
const {ProtocolSession} = await load('core/gather/session.js');
const {Driver} = await load('core/gather/driver.js');
const originalSend = ProtocolSession.prototype.sendCommand;
const originalDisconnect = Driver.prototype.disconnect;
assert(DEFAULT_FLAGS.some(flag => flag.startsWith('--disable-features=') &&
  flag.split('=')[1].split(',').includes('RenderDocument')),
'Require frozen RenderDocument-off setup');
assert(!DEFAULT_FLAGS.some(flag => flag.includes('LimitCrossOriginNonActivatedPaintHolding')),
  'Do not override the paint-holding security policy');
let commands = [];
let measuredGeometry;
ProtocolSession.prototype.sendCommand = async function(method, ...params) {
  if (method === 'Emulation.setDeviceMetricsOverride') {
    await originalSend.call(this, 'Emulation.setScrollbarsHidden', {hidden: false});
    commands.push({method, metrics: params[0], scrollbarsHidden: false});
  }
  return originalSend.call(this, method, ...params);
};
Driver.prototype.disconnect = async function() {
  // Gathering has finished. Read the actual emulated page before detaching
  // its CDP session, which resets emulation to the desktop window geometry.
  try {
    const session = this.defaultSession;
    const value = await session.sendCommand('Runtime.evaluate', {
      expression: '({innerWidth,innerHeight,devicePixelRatio,url:location.href})',
      returnByValue: true,
    });
    measuredGeometry = {window: value.result.value,
      layout: await session.sendCommand('Page.getLayoutMetrics')};
  } catch (error) {
    measuredGeometry = {error: error.message};
  } finally {
    await originalDisconnect.call(this);
  }
};
const html = '<!doctype html><html><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Plain rendering fixture</title><link rel="stylesheet" href="/blocking.css">' +
  '</head><body><h1>Plain rendering fixture</h1>' +
  Array.from({length: 1200}, (_, i) =>
    `<div><p>Static paragraph ${i} for controlled rendering.</p>` +
    '<a href="#top">Static link</a></div>').join('') + '</body></html>';
const css = 'body{margin:24px;background:#fff;color:#111;font:16px system-ui}' +
  'div{padding:2px}a{color:#245}';
const requests = [];
let activeRun;
const server = http.createServer((req, res) => {
  const run = activeRun;
  const body = req.url === '/about' ? html : req.url === '/blocking.css' ? css : '';
  const started = performance.now();
  setTimeout(() => {
    if (res.destroyed) return;
    res.writeHead(body ? 200 : 404, {'content-type': req.url === '/about' ?
      'text/html; charset=utf-8' : 'text/css', 'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)});
    res.end(body);
    requests.push({run, url: req.url, bytes: Buffer.byteLength(body),
      sha256: hash(body), delayMs: performance.now() - started});
  }, req.url === '/about' ? 200 : req.url === '/blocking.css' ? 100 : 0);
});
const settings = {onlyCategories: ['performance'], formFactor: 'mobile',
  throttlingMethod: 'simulate', screenEmulation: {mobile: true, width: 412,
    height: 823, deviceScaleFactor: 1.75, disabled: false},
  additionalTraceCategories: 'cc,viz,renderer.scheduler,disabled-by-default-cc.debug,' +
    'disabled-by-default-devtools.timeline.frame,disabled-by-default-cc.debug.scheduler,' +
    'disabled-by-default-viz.surface_id_flow'};
const sourceFiles = ['.github/scripts/chromium-paired-runtime.mjs',
  'core/index.js', 'core/gather/navigation-runner.js',
  'core/lib/tracehouse/trace-processor.js', 'core/lib/network-recorder.js',
  'core/gather/gatherers/console-messages.js', 'yarn.lock'];
const buildIdentities = {};
for (const [arm, binary] of Object.entries(variants)) {
  const manifestPath = path.join(path.dirname(binary), 'runtime-manifest.json');
  buildIdentities[arm] = {binary, chromeSha256: hash(await fs.readFile(binary)),
    runtimeManifestSha256: hash(await fs.readFile(manifestPath))};
}
assert.notEqual(buildIdentities.A.runtimeManifestSha256, buildIdentities.B.runtimeManifestSha256,
  'Runtime manifests must distinguish the built baseline and fixed binaries');
const sourceIdentities = await Promise.all(sourceFiles.map(async file => ({file,
  sha256: hash(await fs.readFile(path.join(root, file)))})));
await fs.mkdir(output, {recursive: true});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/about`;
await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify({
  workflowGitSha: process.env.GITHUB_SHA || null,
  chromiumRevision,
  chromiumVersion, v8RandomSeed: 17148, order: 'ABBAAB',
  diagnosticMode,
  arms: {A: diagnosticMode === 'instrumented' ? 'diagnostics-only' : 'baseline',
    B: 'same diagnostic mode plus narrow parent-surface fix'}, buildIdentities, settings,
  modes: {normal: {delay: 1, duration: 1}, amplified: {delay: 0.1, duration: 10}},
  fixture: {htmlSha256: hash(html), cssSha256: hash(css), documentDelayMs: 200, cssDelayMs: 100},
  sourceFiles: sourceIdentities,
  method: 'Twelve sequential fresh-profile runs, no retries. Caller-created new page in each run ' +
    'preserves new-tab lifecycle while allowing geometry reads AFTER all Lighthouse metrics. ' +
    'Security policy stays enabled by source default. Same diagnostics in both binaries. ' +
    'Normal fade is explicitly normalized1/1; amplified fade forces overlap ' +
    'and is not a mobile score. ' +
    'Schema/geometry gates do not establish a performance fix or page-sink attribution.', url,
}, null, 2));
function schemaSummary(trace) {
  const events = trace.traceEvents || trace;
  const decisions = events.filter(e => e.name === 'SendBeginFrameDecision');
  const states = events.filter(e => e.name === 'BeginFrameUndrawnState');
  if (diagnosticMode === 'without-added-diagnostics') {
    assert.equal(states.length, 0, 'Confirmation must omit the added counter event');
    assert(decisions.every(e => !('frame_sink_client_id' in e.args) &&
      !('frame_sink_sink_id' in e.args)), 'Confirmation must omit added sink identity fields');
    return {addedDiagnosticEvents: 0, nativeDecisionEvents: decisions.length,
      limitation: 'Timing confirmation only; no added page-sink counter diagnostics.'};
  }
  assert(decisions.length && states.length, 'Both unchanged diagnostic patches must be active');
  const sinks = {};
  for (const {args} of decisions) {
    assert.equal(typeof args.reason, 'string');
    assert.equal(typeof args.should_send, 'boolean');
    for (const key of ['frame_sink_client_id', 'frame_sink_sink_id']) {
      assert(Number.isInteger(args[key]) && args[key] >= 0 && args[key] <= 0xffffffff);
    }
    const key = `${args.frame_sink_client_id}:${args.frame_sink_sink_id}`;
    sinks[key] ||= {decisions: {}, stateEvents: 0};
    sinks[key].decisions[args.reason] = (sinks[key].decisions[args.reason] || 0) + 1;
  }
  for (const {args} of states) {
    for (const key of ['frame_sink_client_id', 'frame_sink_sink_id', 'active_frame_index',
      'last_drawn_frame_index', 'undrawn_frame_count']) {
      assert(Number.isSafeInteger(args[key]) && args[key] >= 0);
    }
    assert.equal(args.undrawn_frame_count, args.active_frame_index - args.last_drawn_frame_index);
    assert.equal(typeof args.may_throttle_if_undrawn_frames, 'boolean');
    assert.equal(typeof args.should_throttle_undrawn_frames, 'boolean');
    assert(Number.isFinite(args.time_since_last_frame_ms));
    assert(Number.isSafeInteger(args.frame_timing_details_count) &&
      args.frame_timing_details_count >= 0);
    assert.equal(typeof args.frame_timing_details_all_failed, 'boolean');
    const key = `${args.frame_sink_client_id}:${args.frame_sink_sink_id}`;
    sinks[key] ||= {decisions: {}, stateEvents: 0};
    sinks[key].stateEvents++;
  }
  return {decisionEvents: decisions.length, stateEvents: states.length, sinks,
    limitation: 'All compositor sinks; page sink requires a separate exact flow/SurfaceId join.'};
}
function overlapEvidence(trace) {
  const es = trace.traceEvents || trace;
  const fc = es.filter(e => e.name === 'firstContentfulPaint').sort((a, b) => b.ts - a.ts)[0];
  if (!fc) return {available: false, reason: 'No FCP event'};
  const nav = es.filter(e => e.name === 'navigationStart' && e.pid === fc.pid && e.ts < fc.ts)
    .sort((a, b) => b.ts - a.ts)[0];
  const commit = es.filter(e => e.name === 'CommitLoad' && e.pid === fc.pid && e.ts < fc.ts &&
    e.args?.data?.isMainFrame).sort((a, b) => b.ts - a.ts)[0];
  const embed = commit && es.filter(e => e.name === 'LocalSurfaceId.Embed.Flow' &&
    e.args?.step === 'SetSurfaceId' && e.ts >= commit.ts && e.ts < fc.ts)
    .sort((a, b) => a.ts - b.ts)[0];
  const text = embed?.args?.surface_id || '';
  const sink = /FrameSinkId\((\d+),\s*(\d+)\)/.exec(text);
  const parent = /LocalSurfaceId\((\d+),/.exec(text);
  const viewports = [];
  for (const e of es) {
    if (e.pid !== fc.pid ||
      !['LayerTreeHostImpl:snapshot', 'cc::LayerTreeHostImpl'].includes(e.name)) continue;
    const size = e.args?.snapshot?.device_viewport_size;
    if (size && !viewports.some(v => v.width === size.width && v.height === size.height)) {
      viewports.push(size);
    }
  }
  assert(viewports.length > 0, 'Missing renderer viewport snapshots');
  assert(viewports.every(v => v.width * 823 === v.height * 412),
    'Measured renderer viewport departed from412×823 portrait geometry');
  const callbacks = es.filter(e => e.pid === fc.pid &&
    e.name === 'LayerTreeHostImpl::SetNeedsAnimateForScrollbarAnimation' &&
    e.ts >= (embed?.ts || nav?.ts || 0) && e.ts < fc.ts);
  if (!nav || !embed || !sink || !parent) {
    return {available: false, measuredViewports: viewports,
      reason: 'Missing exact commit/embed/sink trace fields', callbackCount: callbacks.length};
  }
  const matchesSink = e => e.args?.frame_sink_client_id === Number(sink[1]) &&
    e.args?.frame_sink_sink_id === Number(sink[2]) && e.ts >= embed.ts && e.ts < fc.ts;
  const states = es.filter(e => e.name === 'BeginFrameUndrawnState' && matchesSink(e));
  const oldActivations = es.filter(e => {
    if (e.name !== 'Surface::ActivateFrame' || e.ts < embed.ts || e.ts >= fc.ts) return false;
    const id = e.args?.SurfaceId || '';
    const oldParent = /LocalSurfaceId\((\d+),/.exec(id);
    return id.includes(sink[0]) && oldParent && Number(oldParent[1]) < Number(parent[1]);
  });
  const decisions = es.filter(e => e.name === 'SendBeginFrameDecision' && matchesSink(e) &&
    e.args.reason === 'ThrottleUndrawnFrames' && e.args.should_send === false);
  return {available: true, measuredViewports: viewports, fcpRendererPid: fc.pid,
    pageSink: `${sink[1]}:${sink[2]}`,
    selectedEmbed: {ts: embed.ts, surfaceId: text},
    callbackCountAfterEmbedBeforeFCP: callbacks.length,
    callbackMs: callbacks.map(e => (e.ts - nav.ts) / 1000),
    candidateOldSurfaceActivationMs: oldActivations.map(e => (e.ts - nav.ts) / 1000),
    pageUndrawnStateEvents: states.length,
    maxUndrawnFrameCount: states.length ?
      Math.max(...states.map(e => e.args.undrawn_frame_count)) : null,
    pageUndrawnThrottleDecisions: decisions.length,
    pendingFailedTimingStates: states.filter(e => e.args.frame_timing_details_count > 0 &&
      e.args.frame_timing_details_all_failed).length,
    baselineOverlapEnrolled: callbacks.length > 0 && oldActivations.length > 0,
    baselineUndrawnStallObserved: decisions.length > 0,
    limitation: 'Enrollment labels retain ALL runs. Old activations are joined by sink ' +
      'and parent sequence; full embed-token/flow and scheduler wait joins remain ' +
      'reviewer analysis, ' +
      'not an automatic causal verdict.'};
}

const results = [];
try {
  for (const mode of ['normal', 'amplified']) {
    for (const [index, arm] of [...'ABBAAB'].entries()) {
      activeRun = `${mode}-${index + 1}-${arm}`;
      commands = [];
      measuredGeometry = undefined;
      const row = {run: activeRun, mode, arm, buildIdentity: buildIdentities[arm]};
      const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'lh-paired-parent-surface-'));
      let chrome; let browser; let timer;
      const exitEvents = [];
      try {
        const fade = mode === 'normal' ? ['1.0', '1.0'] : ['0.1', '10.0'];
        const flags = ['--headless=new', '--test-type=gpu', '--js-flags=--random-seed=17148',
          '--enable-features=' +
          'DevToolsWebMCPSupport,ScaleScrollbarAnimationTiming:' +
          `fade_delay_scaling_factor/${fade[0]}/fade_duration_scaling_factor/${fade[1]}`];
        chrome = await launch({chromePath: variants[arm], userDataDir: profile,
          chromeFlags: flags, port: 0, logLevel: 'silent'});
        chrome.process.on('exit', (code, signal) => exitEvents.push({code, signal}));
        row.processArgs = chrome.process.spawnargs;
        assert(!row.processArgs.some(arg =>
          arg.includes('LimitCrossOriginNonActivatedPaintHolding')),
          'Security policy must remain at its enabled default');
        row.version = await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json();
        assert.equal(row.version.Browser, `Chrome/${chromiumVersion}`);
        browser = await puppeteer.connect({browserURL: `http://127.0.0.1:${chrome.port}`,
          defaultViewport: null});
        const page = await browser.newPage();
        const result = await Promise.race([
          lighthouse(url, {port: chrome.port, logLevel: 'error', output: 'json'},
            {extends: 'lighthouse:default', settings}, page),
          new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Collection exceeded120 seconds')), 120000);
          }),
        ]);
        clearTimeout(timer);
        assert(result, 'Missing Lighthouse result');
        await fs.writeFile(path.join(output, `${activeRun}.lhr.json`), JSON.stringify(result.lhr));
        for (const [key, suffix] of [['Trace', 'trace'], ['DevtoolsLog', 'devtoolslog']]) {
          if (result.artifacts?.[key] !== undefined) {
            await fs.writeFile(
              path.join(output, `${activeRun}.${suffix}.json.gz`),
              gzipSync(JSON.stringify(result.artifacts[key])));
          } else (row.missingArtifacts ||= []).push(key);
        }
        row.metrics = result.lhr.audits.metrics?.details?.items?.[0];
        row.runtimeError = result.lhr.runtimeError;
        row.auditErrors = Object.values(result.lhr.audits)
          .filter(a => a.scoreDisplayMode === 'error')
          .map(a => ({id: a.id, message: a.errorMessage}));
        row.deviceMetricCommands = commands;
        row.measuredGeometry = measuredGeometry;
        // Retain the post-cleanup state separately: CDP detach can reset these
        // values to desktop geometry. Validate the pre-detach read above.
        const session = await page.createCDPSession();
        row.afterMetrics = {layout: await session.send('Page.getLayoutMetrics'),
          window: await page.evaluate(() => ({innerWidth: globalThis.innerWidth,
            innerHeight: globalThis.innerHeight, outerWidth: globalThis.outerWidth,
            outerHeight: globalThis.outerHeight, devicePixelRatio: globalThis.devicePixelRatio,
            screenWidth: globalThis.screen.width, screenHeight: globalThis.screen.height,
            url: globalThis.location.href}))};
        assert(!row.measuredGeometry?.error, 'Failed to read geometry before CDP detach');
        assert.equal(row.measuredGeometry?.window?.innerWidth, 412);
        assert.equal(row.measuredGeometry?.window?.innerHeight, 823);
        assert.equal(row.measuredGeometry?.window?.devicePixelRatio, 1.75);
        assert.equal(row.measuredGeometry?.window?.url, url);
        assert.equal(row.afterMetrics.window.url, url);
        assert(commands.length && commands.every(c => c.scrollbarsHidden === false));
        assert(result.artifacts?.Trace && result.artifacts?.DevtoolsLog);
        row.sinkSchema = schemaSummary(result.artifacts.Trace);
        row.overlap = overlapEvidence(result.artifacts.Trace);
        await fs.writeFile(path.join(output, `${activeRun}.sinks.json`),
          JSON.stringify(row.sinkSchema, null, 2));
        assert(!row.runtimeError && row.auditErrors.length === 0, 'Lighthouse audit/runtime error');
      } catch (error) {
        row.error = {name: error.name, message: error.message, stack: error.stack};
      } finally {
        clearTimeout(timer);
        row.deviceMetricCommands = commands;
        if (chrome) {
          row.browserBeforeCleanup = {pid: chrome.process.pid,
            exitCode: chrome.process.exitCode, signalCode: chrome.process.signalCode,
            exitEvents: [...exitEvents]};
        }
        for (const name of ['chrome-out.log', 'chrome-err.log']) {
          try {
            await fs.copyFile(path.join(profile, name), path.join(output, `${activeRun}.${name}`));
          } catch (error) {
            (row.logCopyErrors ||= []).push({name, message: error.message});
          }
        }
        if (browser) await browser.disconnect().catch(() => {});
        if (chrome) {
          try {
            await chrome.kill();
          } catch (error) {
            row.cleanupError = error.message;
          }
        }
        await fs.rm(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 200})
          .catch(error => {
            row.profileCleanupError = error.message;
          });
        results.push(row);
        await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
        await fs.writeFile(path.join(output, 'requests.json'), JSON.stringify(requests, null, 2));
        console.log(JSON.stringify({run: activeRun, fcp: row.metrics?.observedFirstContentfulPaint,
          stateEvents: row.sinkSchema?.stateEvents, error: row.error?.message}));
      }
    }
  }
} finally {
  ProtocolSession.prototype.sendCommand = originalSend;
  Driver.prototype.disconnect = originalDisconnect;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
const baselineRuns = results.filter(r => r.arm === 'A');
const summary = {
  performanceConclusion: baselineRuns.some(r => r.overlap?.baselineOverlapEnrolled &&
    r.overlap?.baselineUndrawnStallObserved) ?
    'Baseline overlap and page-sink undrawn throttling observed; ' +
      'inspect paired traces before a fix claim.' :
    'INCONCLUSIVE: baseline overlap plus page-sink undrawn throttling was not observed; ' +
      'no performance fix proven.',
  complete: results.length === 12 &&
    results.every(r => !r.error && !r.cleanupError && !r.profileCleanupError),
  runs: results.map(r => ({run: r.run, mode: r.mode, arm: r.arm,
    fcpMs: r.metrics?.observedFirstContentfulPaint, overlap: r.overlap, error: r.error})),
  limitation: 'Completion checks data quality only. No performance threshold, retries, ' +
    'or automatic causal verdict. Inspect exact page-sink flow joins and undrawn predicates ' +
    'in baseline/fixed traces before claiming a fix.'};
await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
if (!summary.complete) process.exitCode = 1;
