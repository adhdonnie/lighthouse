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
assert.equal(manifest.order, 'VHHVVH');
assert.equal(results.length, 6);
assert.deepEqual(manifest.fixture, {
  htmlSha256: 'dffd730f1d3d1cfd6c3b0da9b45210a5c953de84af7fe9134139e21199247168',
  cssSha256: '314e17787863d5f56d069948511a6cd515ac836d680b5596a467dd785e94af4c',
});
const normalize = args => args.filter(arg =>
  !/^--(?:remote-debugging-port|user-data-dir)=/.test(arg));
const normalized = normalize(results[0].processArgs);
for (const [index, row] of results.entries()) {
  const arm = manifest.order[index];
  assert.equal(row.run, `${index + 1}-${arm}`);
  assert.equal(row.arm, arm);
  assert.equal(row.version.Browser, `Chrome/${expectedVersion}`);
  assert(!row.error && !row.runtimeError,
    `${row.run}: collection must succeed without retries`);
  assert.equal(row.auditErrors.length, 0);
  assert(Number.isFinite(row.metrics?.observedFirstContentfulPaint),
    'An unsupported or missing old-browser metric must not be accepted');
  assert.deepEqual(normalize(row.processArgs), normalized,
    'Only ephemeral profile/port may differ');
  assert(row.processArgs.includes('--test-type=gpu'));
  assert(row.processArgs.some(arg => arg.startsWith('--disable-features=') &&
    arg.slice('--disable-features='.length).split(',').includes('RenderDocument')));
  assert.equal(row.scrollbarCommands.length, 3);
  assert(row.scrollbarCommands.every(command => command.params.hidden === (arm === 'H')));
  const normalizedCommands = row.scrollbarCommands.map(command => ({
    ...command, params: {hidden: 'CONTROL'},
  }));
  assert.deepEqual(normalizedCommands, results[0].scrollbarCommands.map(command => ({
    ...command, params: {hidden: 'CONTROL'},
  })), 'All actual device metrics payloads must match');
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
  results: results.map(row => ({run: row.run, arm: row.arm,
    fcpMs: row.metrics.observedFirstContentfulPaint})), files};
fs.writeFileSync(path.join(root, 'validated-summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary.results, null, 2));
