const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const adb = require('./adb');
const { Analyzer } = require('./analyzer');
const { parseLine } = require('./parse');

const DIR = path.join(require('./paths').DATA, 'sessions');
fs.mkdirSync(DIR, { recursive: true });

class Session extends EventEmitter {
  constructor({ serial, pkg, device, build, rules }) {
    super();
    this.serial = serial;
    this.pkg = pkg;
    this.device = device;
    this.build = build || {};
    this.startedAt = Date.now();
    this.id = new Date(this.startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + pkg;
    this.analyzer = new Analyzer(pkg, rules);
    this.memory = [];
    this.connection = [];
    this.broadcastAll = false;
    this.stopped = false;
    this.endedAt = null;
    this.pending = [];
    this.buf = '';
    this.lastTs = null;
    this.timers = [];
    this.analyzer.onAnr = (ev) => this.captureAnr(ev);
  }

  async start({ clear = true, launch = true } = {}) {
    if (clear) await adb.clearLogcat(this.serial);
    // an already-running copy is about to be force-stopped on launch, so don't count it
    if (!launch) (await adb.pids(this.serial, this.pkg)).forEach((p) => this.analyzer.pids.add(p));
    // make Firebase Analytics print its events (e.g. level Started/Ended) into logcat
    await adb.sh(this.serial, 'setprop log.tag.FA VERBOSE; setprop log.tag.FA-SVC VERBOSE');
    this.spawn();
    if (launch) {
      await adb.sh(this.serial, 'input keyevent KEYCODE_WAKEUP'); // a locked screen would swallow the launch
      await adb.forceStop(this.serial, this.pkg);
      await new Promise((r) => setTimeout(r, 600));
      await adb.launch(this.serial, this.pkg);
    }
    const every = (ms, fn) => this.timers.push(setInterval(() => fn().catch(() => {}), ms));
    every(1500, async () => {
      (await adb.pids(this.serial, this.pkg)).forEach((p) => this.analyzer.pids.add(p));
    });
    every(10000, async () => {
      const kb = await adb.memoryKb(this.serial, this.pkg);
      if (kb) {
        this.memory.push([Date.now(), kb]);
        if (this.memory.length > 3000) this.memory.shift();
      }
    });
    every(150, async () => this.pump());
    every(1000, async () => { this.analyzer.tick(); this.pump(); this.emit('msg', { k: 'stats', v: this.liveStats() }); });
    every(30000, async () => this.save());
  }

  spawn() {
    const proc = adb.logcat(this.serial, this.lastTs);
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const raw = this.buf.slice(0, i).replace(/\r$/, '');
        this.buf = this.buf.slice(i + 1);
        this.handle(raw);
      }
    });
    proc.on('close', () => {
      if (this.stopped) return;
      this.note('Device connection lost - retrying...');
      this.emit('msg', { k: 'device', v: 'offline' });
      setTimeout(() => {
        if (this.stopped) return;
        this.spawn();
        this.emit('msg', { k: 'device', v: 'online' });
        this.note('Reconnected');
      }, 3000);
    });
  }

  note(text) {
    this.connection.push({ t: Date.now(), text });
    this.analyzer.addTimeline(this.analyzer.lastT || Date.now(), 'warn', text);
    this.emit('msg', { k: 'note', v: text });
  }

  handle(raw) {
    const l = parseLine(raw);
    if (!l) return;
    this.lastTs = raw[4] === '-' ? raw.slice(5, 23) : raw.slice(0, 18); // "MM-DD HH:MM:SS.mmm" for logcat -T on reconnect
    const e = this.analyzer.feed(l);
    if (e) this.pending.push({ k: 'line', v: { ...e } });
    else if (this.broadcastAll && !this.analyzer.pids.has(l.pid)) {
      this.pending.push({ k: 'line', v: { id: 'x' + this.analyzer.nextId++, t: l.t, pid: l.pid, tid: l.tid, lvl: l.lvl, tag: l.tag, msg: l.msg, x: 1 } });
    }
  }

  pump() {
    for (const o of this.analyzer.drain()) this.pending.push(o);
    if (!this.pending.length) return;
    const batch = this.pending;
    this.pending = [];
    this.emit('batch', batch);
  }

  async captureAnr(ev) {
    await new Promise((r) => setTimeout(r, 4000));
    try {
      ev.traces = await adb.lastAnrTrace(this.serial, this.pkg);
      if (ev.traces) this.emit('batch', [{ k: 'anr-update', v: { id: ev.id, traces: ev.traces } }]);
    } catch (_) { /* best effort */ }
  }

  liveStats() {
    const s = this.analyzer.summary();
    return {
      counts: s.counts, currentLevel: s.currentLevel, startupMs: s.startupMs,
      elapsed: Date.now() - this.startedAt, pids: [...this.analyzer.pids].slice(-3),
      memoryKb: this.memory.length ? this.memory[this.memory.length - 1][1] : null,
      levels: s.levels.length,
    };
  }

  snapshot(limit = 4000) {
    return {
      meta: this.meta(),
      entries: this.analyzer.entries.slice(-limit),
      summary: this.analyzer.summary(),
    };
  }

  meta() {
    return {
      id: this.id, pkg: this.pkg, serial: this.serial, device: this.device, build: this.build,
      startedAt: this.startedAt, endedAt: this.endedAt, memory: this.memory, connection: this.connection,
      live: !this.stopped,
    };
  }

  full() {
    const stackOf = (e) => (e.stack && e.stack.length ? e.stack : undefined);
    return {
      meta: this.meta(),
      summary: this.analyzer.summary(),
      entries: this.analyzer.entries.slice(-100000).map((e) => ({ ...e, stack: stackOf(e) })),
    };
  }

  save() {
    try {
      fs.writeFileSync(path.join(DIR, this.id + '.json'), JSON.stringify(this.full()));
    } catch (e) { console.error('save failed', e.message); }
  }

  reanalyze(rules) {
    this.analyzer.reanalyze(rules);
    this.emit('batch', [{ k: 'reset', v: this.snapshot() }]);
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.timers.forEach(clearInterval);
    if (this.proc) this.proc.kill();
    this.analyzer.finish();
    if (this.analyzer.cur) this.analyzer.cur.note = 'session ended';
    this.pump();
    this.endedAt = Date.now();
    this.save();
    this.emit('batch', [{ k: 'stopped', v: this.meta() }]);
  }
}

function listSessions() {
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      const m = j.meta, c = j.summary.counts;
      return {
        id: m.id, pkg: m.pkg, device: m.device, build: m.build, startedAt: m.startedAt, endedAt: m.endedAt,
        crashes: c.crashes, anrs: c.anrs, killed: c.killed, errors: c.errors, levels: j.summary.levels.length,
      };
    } catch (_) { return null; }
  }).filter(Boolean).sort((a, b) => b.startedAt - a.startedAt);
}

const loadSession = (id) => JSON.parse(fs.readFileSync(path.join(DIR, path.basename(id) + '.json'), 'utf8'));
const deleteSession = (id) => fs.unlinkSync(path.join(DIR, path.basename(id) + '.json'));

module.exports = { Session, listSessions, loadSession, deleteSession };
