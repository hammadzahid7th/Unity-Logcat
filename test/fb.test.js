const assert = require('assert');
const { Analyzer } = require('../lib/analyzer');
const { parseLine } = require('../lib/parse');
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mk = (p) => `name=${esc('Steps')},.*?[{, ]${esc(p)}=([^,}\\s]+)`;
const a = new Analyzer('com.g', { start: mk('Started'), end: mk('Ended'), fail: '(?!)' });
a.pids.add(10);
const L = (t, m) => `2026-10-22 10:00:${t}.000    10    10 V FA-SVC : ${m}`;
for (const r of [
  L('00', 'Logging event: origin=app,name=Steps,params=Bundle[{Started=0, ga_event_origin(_o)=app}]'),
  L('30', 'Logging event: origin=app,name=Steps,params=Bundle[{ga_event_origin(_o)=app, Ended=0}]'),
  L('40', 'Logging event: origin=app,name=Steps,params=Bundle[{Started=1}]'),
  L('55', 'Logging event: origin=app,name=ad_impression,params=Bundle[{Started=9}]'),
  L('58', 'Logging event: origin=app,name=Steps,params=Bundle[{Ended=1}]'),
]) a.feed(parseLine(r));
const s = a.summary();
assert.deepStrictEqual(s.levels.map((x) => [x.id, x.avgMs]), [['0', 30000], ['1', 18000]]);
assert.strictEqual(s.levelTotals.gapAvgMs, 10000);
console.log('firebase ok');
