// Usage: node check-sink-trace.mjs chromium-trace.json[.gz]
// A schema/association gate, not proof of a scheduler bug or its cause.
import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
let bytes = fs.readFileSync(process.argv[2]);
if (process.argv[2].endsWith('.gz')) bytes = gunzipSync(bytes);
const trace = JSON.parse(bytes);
const events = (trace.traceEvents || trace).filter(e => e.name === 'SendBeginFrameDecision');
assert(events.length > 0, 'No decision events: record the viz category');
const sinks = new Map();
for (const event of events) {
  const args = event.args;
  assert.equal(typeof args.reason, 'string');
  assert.equal(typeof args.should_send, 'boolean');
  for (const key of ['frame_sink_client_id', 'frame_sink_sink_id']) {
    assert(Number.isInteger(args[key]) && args[key] >= 0 && args[key] <= 0xffffffff,
      `Missing or invalid ${key}; this binary may lack the diagnostic patch`);
  }
  const key = `${args.frame_sink_client_id}:${args.frame_sink_sink_id}`;
  if (!sinks.has(key)) sinks.set(key, {});
  const reasons = sinks.get(key);
  reasons[args.reason] = (reasons[args.reason] || 0) + 1;
}
console.log(JSON.stringify({events: events.length, sinks: Object.fromEntries(sinks)}, null, 2));
