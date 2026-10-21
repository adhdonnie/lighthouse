/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root = path.resolve(process.argv[2]);
const expectedVersion = process.argv[3];
assert(expectedVersion, 'Expected pinned browser version is required');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const manifest = read('manifest.json');
const results = read('results.json');
const requests = read('requests.json');
assert.equal(manifest.parameterOrder, 'FTTFFT');
assert.equal(manifest.order, 'VVVVVV');
assert.equal(results.length, 6);
assert.deepEqual(manifest.fixture, {
  htmlSha256: 'dffd730f1d3d1cfd6c3b0da9b45210a5c953de84af7fe9134139e21199247168',
  cssSha256: '314e17787863d5f56d069948511a6cd515ac836d680b5596a467dd785e94af4c',
});
const normalize = args => args.filter(arg =>
  !/^--(?:remote-debugging-port|user-data-dir)=/.test(arg))
  .map(arg => arg.replace(/MigratedChromeForTesting\/(true|false)/g,
    'MigratedChromeForTesting/CONTROL'));
const normalized = normalize(results[0].processArgs);
for (const [index, row] of results.entries()) {
  const enabled = manifest.parameterOrder[index] === 'T';
  assert.equal(row.run, `${index + 1}-V`);
  assert.equal(row.arm, 'V');
  assert.equal(row.infobarMigration, enabled);
  assert.equal(row.version.Browser, `Chrome/${expectedVersion}`);
  assert(!row.error && !row.runtimeError && !row.histogramError,
    `${row.run}: collection and histogram retrieval must succeed without retries`);
  assert.equal(row.auditErrors.length, 0);
  assert(Number.isFinite(row.metrics.observedFirstContentfulPaint));
  assert.deepEqual(normalize(row.processArgs), normalized,
    'Only migration boolean and ephemeral profile/port may differ');
  const featureArgs = row.processArgs.filter(arg => arg.startsWith('--enable-features='));
  assert.equal(featureArgs.length, 1);
  const parameterMatches = featureArgs[0].match(/MigratedChromeForTesting\/(true|false)/g);
  assert.deepEqual(parameterMatches, [`MigratedChromeForTesting/${enabled}`]);
  assert(row.processArgs.some(arg => arg.startsWith('--disable-features=') &&
    arg.slice('--disable-features='.length).split(',').includes('RenderDocument')));
  assert.equal(row.scrollbarCommands.length, 3);
  assert(row.scrollbarCommands.every(command => command.params.hidden === false));
  const histograms = row.infobarHistograms.histograms;
  assert(Array.isArray(histograms));
  const cfTCount = histograms.filter(item => item.name === 'InfoBar.Centralized.Show')
    .flatMap(item => item.buckets)
    .filter(bucket => bucket.low === 112 && bucket.high === 113)
    .reduce((sum, bucket) => sum + bucket.count, 0);
  assert(enabled ? cfTCount > 0 : cfTCount === 0,
    `${row.run}: histogram bucket112 must prove active CfT migration only in enabled arm`);
  for (const [endpoint, bytes, sha256] of [
    ['/about', 113147, manifest.fixture.htmlSha256],
    ['/blocking.css', 93, manifest.fixture.cssSha256],
  ]) {
    const records = requests.filter(item => item.run === row.run && item.url === endpoint);
    assert(records.length > 0, `${row.run}: missing ${endpoint} evidence`);
    assert(records.every(item => item.bytes === bytes && item.sha256 === sha256));
  }
  for (const suffix of ['lhr.json', 'trace.json.gz', 'devtoolslog.json.gz',
    'chrome-err.log', 'chrome-out.log']) {
    assert(fs.existsSync(path.join(root, `${row.run}.${suffix}`)),
      `${row.run}: missing ${suffix}`);
  }
}
const files = fs.readdirSync(root).filter(name => name !== 'validated-summary.json')
  .filter(name => fs.statSync(path.join(root, name)).isFile())
  .sort().map(name => ({name, sha256: createHash('sha256')
    .update(fs.readFileSync(path.join(root, name))).digest('hex')}));
const summary = {complete: true, version: expectedVersion,
  noTimingPassThreshold: true, noRetries: true,
  results: results.map(row => ({run: row.run, migration: row.infobarMigration,
    fcpMs: row.metrics.observedFirstContentfulPaint,
    histograms: row.infobarHistograms.histograms})), files};
fs.writeFileSync(path.join(root, 'validated-summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary.results, null, 2));
