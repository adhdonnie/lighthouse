/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */


// Run against a Lighthouse checkout with both proposed collection fixes applied.
// Usage: node renderdocument-matrix.mjs /path/to/lighthouse /path/to/results
// CHROME_PATH optionally selects a full Chrome binary. Node >=22 is required.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import assert from 'node:assert/strict';

const root = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const load = relative => import(pathToFileURL(path.join(root, relative)).href);
const {default: lighthouse} = await load('core/index.js');
const launcher = await load('node_modules/chrome-launcher/dist/index.js');
const {DEFAULT_FLAGS} = await load('node_modules/chrome-launcher/dist/flags.js');
const {createServers} = await load('cli/test/fixtures/static-server.js');
const {getAssertionReport} = await load('cli/test/smokehouse/report-assert.js');
const defaultTests = [
  'dobetterweb', 'oopif-requests', 'oopif-scripts', 'redirects-single-server',
  'redirects-multiple-server', 'redirects-history-push-state',
  'metrics-delayed-fcp', 'metrics-delayed-lcp', 'a11y',
];
const tests = process.env.MATRIX_TESTS?.split(',') || defaultTests;
const defaults = [...DEFAULT_FLAGS];
const candidate = defaults.map(flag => flag.startsWith('--disable-features=') ?
  '--disable-features=' + flag.slice('--disable-features='.length).split(',')
    .filter(feature => feature !== 'RenderDocument').join(',') : flag);
assert.notDeepEqual(candidate, defaults, 'Baseline must disable RenderDocument');
assert.equal(defaults.filter(flag => flag.startsWith('--disable-features=')).length, 1);
await fs.mkdir(output, {recursive: true});
const servers = await createServers();
const results = [];
try {
  for (const id of tests) {
    const {default: definition} = await load(`cli/test/smokehouse/test-definitions/${id}.js`);
    for (const arm of (process.env.MATRIX_ARMS || 'default,restored').split(',')) {
      // Change only the candidate default in this serial process. Let Launcher
      // retain its platform flags, profile management and port selection.
      DEFAULT_FLAGS.splice(0, DEFAULT_FLAGS.length, ...(arm === 'default' ? defaults : candidate));
      const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'lh-renderdocument-'));
      const cookieMode = process.env.MATRIX_COOKIE_MODE;
      if (cookieMode) {
        assert(['allow', 'block'].includes(cookieMode));
        await fs.mkdir(path.join(profile, 'Default'), {recursive: true});
        const prefs = {profile: {cookie_controls_mode: cookieMode === 'allow' ? 0 : 1}};
        await fs.writeFile(path.join(profile, 'Default/Preferences'), JSON.stringify(prefs));
      }
      let chrome;
      let timeout;
      const row = {
        id, arm, platform: process.platform, arch: process.arch, node: process.version,
        cookieMode: cookieMode || 'browser-default',
      };
      try {
        chrome = await launcher.launch({
          chromePath: process.env.CHROME_PATH, userDataDir: profile, port: 0,
          chromeFlags: ['--headless=new', '--enable-features=DevToolsWebMCPSupport'],
          logLevel: 'silent'});
        row.processArgs = chrome.process.spawnargs;
        servers.forEach(server => server.takeRequestUrls());
        console.log(JSON.stringify({id, arm, stage: 'gather', port: chrome.port}));
        const result = await Promise.race([
          lighthouse(definition.expectations.lhr.requestedUrl,
            {port: chrome.port, output: 'json', logLevel: process.env.MATRIX_LOG_LEVEL || 'error'},
            definition.config),
          new Promise((resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('Collection exceeded matrix timeout')),
              Number(process.env.MATRIX_TIMEOUT_MS || 240000));
          }),
        ]);
        row.environment = result.lhr.environment;
        row.runtimeError = result.lhr.runtimeError;
        row.auditErrors = Object.values(result.lhr.audits)
          .filter(audit => audit.scoreDisplayMode === 'error')
          .map(audit => ({id: audit.id, message: audit.errorMessage}));
        row.consoleMessages = result.artifacts.ConsoleMessages;
        row.metrics = result.lhr.audits.metrics?.details?.items;
        const report = getAssertionReport(result, definition.expectations, {runner: 'cli'});
        row.assertions = {passed: report.passed, failed: report.failed};
        await fs.writeFile(path.join(output, `${id}-${arm}.assertions.txt`), report.log);
        await fs.writeFile(path.join(output, `${id}-${arm}.lhr.json`), JSON.stringify(result.lhr));
        await fs.writeFile(path.join(output, `${id}-${arm}.artifacts.json.gz`),
          gzipSync(JSON.stringify(result.artifacts)));
      } catch (error) {
        row.error = {message: error.message, stack: error.stack};
      } finally {
        clearTimeout(timeout);
        try {
          if (chrome) await chrome.kill();
          try {
            const filename = path.join(profile, 'Default/Preferences');
            const prefs = JSON.parse(await fs.readFile(filename, 'utf8'));
            row.cookiePreferences = {
              mode: prefs.profile?.cookie_controls_mode,
              blockThirdParty: prefs.profile?.block_third_party_cookies,
            };
          } catch {}
          // Windows can retain file handles briefly after taskkill completes.
          await fs.rm(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
        } catch (error) {
          row.cleanupError = {message: error.message, stack: error.stack};
        }
        results.push(row);
        await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
        console.log(JSON.stringify({id, arm, assertions: row.assertions,
          runtimeError: row.runtimeError, error: row.error?.message,
          cleanupError: row.cleanupError?.message}));
      }
      // Preserve the result before aborting if a browser/profile could not be cleaned up.
      if (row.cleanupError) throw new Error(row.cleanupError.message);
    }
  }
} finally {
  DEFAULT_FLAGS.splice(0, DEFAULT_FLAGS.length, ...defaults);
  await Promise.all(servers.map(server => server.close()));
}
// Keep baseline failures visible; never silently reclassify them as passing.
if (results.some(row => row.error || row.cleanupError ||
    row.runtimeError || row.assertions?.failed)) {
  process.exitCode = 1;
}
