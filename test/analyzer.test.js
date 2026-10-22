const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { Analyzer } = require('../lib/analyzer');
const { parseLine } = require('../lib/parse');

const a = new Analyzer('com.studio.game');
for (const raw of fs.readFileSync(path.join(__dirname, 'sample.log'), 'utf8').split('\n')) {
  const l = parseLine(raw);
  if (l) a.feed(l);
}
a.finish();
const s = a.summary();

assert.strictEqual(s.counts.crashes, 1, 'one native crash');
assert.strictEqual(s.counts.anrs, 1, 'one ANR');
assert.strictEqual(s.counts.killed, 0, 'death merged into crash');
assert.strictEqual(s.startupMs, 1480);
const L = Object.fromEntries(s.levels.map((x) => [x.id, x]));
assert.strictEqual(L['1'].avgMs, 17000);
assert.strictEqual(L['2'].attempts, 2);
assert.strictEqual(L['2'].failed, 1);
assert.strictEqual(L['2'].avgMs, 14000);
assert.strictEqual(L['2'].anrs, 1);
assert.strictEqual(L['3'].crashed, 1);
assert.strictEqual(L['3'].completed, 1);
assert.strictEqual(s.incidents.find((c) => c.kind === 'native').level, '3');
assert.match(s.incidents.find((c) => c.kind === 'native').summary, /SIGSEGV in libil2cpp\.so/);
assert.strictEqual(s.topErrors[0].stack.length, 3, 'unity stack grouped');
a.reanalyze({});
assert.strictEqual(a.summary().levels.length, 3);
console.log('analyzer ok', JSON.stringify(s.levels.map((x) => [x.id, x.avgMs, x.crashed, x.anrs])));
