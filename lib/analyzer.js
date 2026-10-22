// Turns a stream of parsed logcat lines into: app log entries (with stacks), crashes, ANRs,
// process deaths, level attempts/timings and grouped errors. Pure logic, no I/O.

const DEFAULT_RULES = {
  start: String.raw`LEVEL[_\s-]*(?:START(?:ED)?|BEGIN)\b\W*(\w+)|LEVEL\W*(\w+)\W+(?:started|begin|began)\b`,
  end: String.raw`LEVEL[_\s-]*(?:END|COMPLETE[D]?|WIN|WON|FINISH(?:ED)?|SUCCESS)\b\W*(\w+)|LEVEL\W*(\w+)\W+(?:completed?|won|finished|cleared)\b`,
  fail: String.raw`LEVEL[_\s-]*(?:FAIL(?:ED)?|LOSE|LOST|DEFEAT)\b\W*(\w+)|LEVEL\W*(\w+)\W+(?:failed|lost)\b`,
  event: String.raw`\[PM\]\s*EVENT\s+(.+)`,
};

const GAP_MS = 1500;
const BENIGN_DEATH = /stop |remove task|swipe|force.?stop|user request|clear data|uninstall|update/i;
const FRAME = [
  /^\s*at\s/,
  /\(at [^)]*:\d+\)\s*$/,
  /^[A-Za-z_][\w.<>`+/]*:[\w.<>`+]+\s*\(.*\)\s*$/,
  /^\s*(?:Caused by:|\.\.\. \d+ more|--- End of)/,
  /^\s*(?:\w+\.)+\w+\(.*\)\s*$/,
];
const isFrame = (m) => FRAME.some((r) => r.test(m));

function compile(src, fallback) {
  try { return new RegExp(src || fallback, 'i'); } catch (_) { return new RegExp(fallback, 'i'); }
}
const firstGroup = (m) => (m.slice(1).find((x) => x !== undefined) || '').trim();

function parseDisplayed(s) {
  const m = /(?:(\d+)s)?(?:(\d+)ms)?/.exec(s.trim());
  return m ? (+(m[1] || 0)) * 1000 + (+(m[2] || 0)) : null;
}

class Analyzer {
  constructor(pkg, rules) {
    this.pkg = pkg;
    this.setRules(rules);
    this.reset();
    this.pids = new Set();
    this.crashes = [];
    this.out = [];
    this.lastFeedWall = 0;
    this.blocks = {};
    this.pendingDied = [];
    this.killReason = new Map();
    this.procs = new Map();
    this.lastUnity = new Map();
    this.nextId = 1;
    this.entries = [];
    this.counts = { lines: 0, errors: 0, warnings: 0, exceptions: 0 };
    this.firstT = 0;
    this.lastT = 0;
    this.startupMs = null;
  }

  reset() {
    this.attempts = [];
    this.cur = null;
    this.lastEnd = null;
    this.errGroups = new Map();
    this.timeline = [];
    this.appEvents = [];
  }

  setRules(rules) {
    this.rules = { ...DEFAULT_RULES, ...(rules || {}) };
    this.re = {
      start: compile(this.rules.start, DEFAULT_RULES.start),
      end: compile(this.rules.end, DEFAULT_RULES.end),
      fail: compile(this.rules.fail, DEFAULT_RULES.fail),
      event: compile(this.rules.event, DEFAULT_RULES.event),
    };
  }

  drain() { const o = this.out; this.out = []; return o; }
  emit(k, v) { this.out.push({ k, v }); }

  // ---- main entry point -------------------------------------------------
  feed(l) {
    this.lastFeedWall = Date.now();
    this.counts.lines++;
    if (!this.firstT) this.firstT = l.t;
    this.lastT = l.t;
    this.flush(l.t);
    this.watchSystem(l);
    this.watchBlocks(l);

    const isApp = this.pids.has(l.pid) || (l.msg.includes(this.pkg) && !/^(ActivityManager|ActivityTaskManager|DEBUG|crash_dump(32|64))$/.test(l.tag));
    if (!isApp) return null;
    if (this.pids.has(l.pid)) {
      const p = this.procs.get(l.pid) || { pid: l.pid, firstT: l.t, lastT: l.t };
      p.lastT = l.t;
      this.procs.set(l.pid, p);
    }
    return this.appEntry(l);
  }

  watchSystem(l) {
    if (l.tag === 'ActivityManager' || l.tag === 'ActivityTaskManager') {
      let m = /Start proc (\d+):([^/\s]+)/.exec(l.msg);
      if (m && m[2] === this.pkg) this.pids.add(+m[1]);
      m = /Killing (\d+):([^/\s]+)\S* \([^)]*\): (.*)/.exec(l.msg);
      if (m && m[2] === this.pkg) this.killReason.set(+m[1], m[3]);
      m = /Process (\S+) \(pid (\d+)\) has died/.exec(l.msg);
      if (m && m[1] === this.pkg) {
        this.pendingDied.push({ t: l.t, pid: +m[2], reason: this.killReason.get(+m[2]) || '' });
      }
      m = /Displayed ([^/\s]+)\/\S+: \+(\S+)/.exec(l.msg);
      if (m && m[1] === this.pkg) {
        const ms = parseDisplayed(m[2]);
        if (this.startupMs === null) this.startupMs = ms;
        this.addTimeline(l.t, 'launch', `App displayed in ${ms} ms`);
      }
    } else if (l.tag === 'lmkd') {
      const m = /Kill '([^']+)' \((\d+)\)/.exec(l.msg);
      if (m && m[1] === this.pkg) this.killReason.set(+m[2], 'killed by low-memory killer');
    }
  }

  // ---- multi-line blocks: java crash, native crash, ANR -----------------
  watchBlocks(l) {
    const b = this.blocks;
    if (l.tag === 'AndroidRuntime') {
      if (/^FATAL EXCEPTION/.test(l.msg)) {
        if (b.java) this.finishBlock('java');
        b.java = { t: l.t, pid: l.pid, lines: [l.msg], lastT: l.t, thread: l.msg };
      } else if (b.java && b.java.pid === l.pid) {
        if (b.java.lines.length < 200) b.java.lines.push(l.msg);
        b.java.lastT = l.t;
        const pm = /^Process: (\S+?),/.exec(l.msg);
        if (pm) b.java.pkg = pm[1];
      }
    }
    if (/^(DEBUG|crash_dump(32|64))$/.test(l.tag)) {
      if (l.msg.includes('*** *** ***')) {
        if (b.native) this.finishBlock('native');
        b.native = { t: l.t, pid: 0, lines: [], lastT: l.t };
      }
      if (b.native) {
        if (b.native.lines.length < 400) b.native.lines.push(l.msg);
        b.native.lastT = l.t;
      }
    }
    if (l.tag === 'ActivityManager') {
      const m = /^ANR in (\S+)/.exec(l.msg);
      if (m) {
        if (b.anr) this.finishBlock('anr');
        b.anr = { t: l.t, pkg: m[1], lines: [l.msg], lastT: l.t };
      } else if (b.anr && b.anr.lines.length < 120) {
        b.anr.lines.push(l.msg);
        b.anr.lastT = l.t;
      }
    }
  }

  flush(t, force) {
    for (const k of ['java', 'native', 'anr']) {
      const b = this.blocks[k];
      if (b && (force || t - b.lastT > GAP_MS)) this.finishBlock(k);
    }
    const keep = [];
    for (const d of this.pendingDied) {
      if (force || t - d.t > 2500) this.settleDeath(d); else keep.push(d);
    }
    this.pendingDied = keep;
  }

  tick() {
    if (this.lastFeedWall && Date.now() - this.lastFeedWall > GAP_MS) this.flush(this.lastT, true);
  }

  finish() {
    this.flush(this.lastT, true);
  }

  finishBlock(k) {
    const b = this.blocks[k];
    delete this.blocks[k];
    if (!b) return;
    const text = b.lines.join('\n');
    let ev = null;
    if (k === 'java') {
      const pkg = b.pkg || '';
      const mine = pkg ? pkg === this.pkg : this.pids.has(b.pid);
      if (!mine) return;
      const exc = b.lines.find((x) => /^[\w.$]+(Exception|Error)\b/.test(x)) || b.lines[2] || b.lines[0];
      ev = { type: 'crash', kind: 'java', t: b.t, pid: b.pid, summary: exc, thread: b.thread, text };
    } else if (k === 'native') {
      const who = /pid: (\d+), tid: \d+, name: (.*?)\s+>>> (\S+) <<</.exec(text);
      if (!who || who[3] !== this.pkg) return;
      const sig = /signal (\d+) \((\w+)\)([^\n]*)/.exec(text);
      const abort = /Abort message: '?(.*?)'?$/m.exec(text);
      const frame = /#00 pc [0-9a-f]+\s+(\S+)/.exec(text);
      const lib = frame ? frame[1].split('/').pop() : null;
      ev = {
        type: 'crash', kind: 'native', t: b.t, pid: +who[1], thread: who[2],
        signal: sig ? sig[2] : null,
        summary: `${sig ? sig[2] : 'native crash'}${lib ? ' in ' + lib : ''}${abort ? ' - ' + abort[1].slice(0, 120) : ''}`,
        text,
      };
    } else if (k === 'anr') {
      if (b.pkg !== this.pkg) return;
      const reason = (/Reason: (.*)/.exec(text) || [])[1] || 'ANR';
      const pid = +((/PID: (\d+)/.exec(text) || [])[1] || 0);
      ev = { type: 'anr', kind: 'anr', t: b.t, pid, summary: reason, text, traces: null };
    }
    if (!ev) return;
    ev.id = this.nextId++;
    ev.level = this.cur ? this.cur.id : null;
    this.noteInLevel(ev);
    this.crashes.push(ev);
    this.addTimeline(ev.t, ev.type, `${ev.type === 'anr' ? 'ANR' : 'CRASH'}: ${ev.summary}`);
    this.emit(ev.type, ev);
    if (ev.type === 'anr' && this.onAnr) this.onAnr(ev);
  }

  settleDeath(d) {
    const merged = this.crashes.some((c) => c.pid === d.pid && Math.abs(c.t - d.t) < 12000);
    if (merged) {
      for (const c of this.crashes) if (c.pid === d.pid && Math.abs(c.t - d.t) < 12000) c.died = true;
      return;
    }
    const benign = BENIGN_DEATH.test(d.reason);
    const ev = {
      id: this.nextId++, type: 'died', kind: benign ? 'closed' : 'killed', t: d.t, pid: d.pid,
      summary: benign ? `App closed (${d.reason || 'user'})` : `Process died unexpectedly${d.reason ? ': ' + d.reason : ''}`,
      level: this.cur ? this.cur.id : null, text: d.reason,
    };
    if (!benign) this.noteInLevel(ev);
    else if (this.cur) this.closeAttempt('abandoned', d.t);
    this.crashes.push(ev);
    this.addTimeline(ev.t, benign ? 'info' : 'died', ev.summary);
    this.emit('died', ev);
  }

  noteInLevel(ev) {
    if (!this.cur) return;
    if (ev.type === 'anr') { this.cur.anrs++; return; }
    this.cur.crashes++;
    this.closeAttempt(ev.type === 'died' ? 'killed' : 'crashed', ev.t);
  }

  // ---- app log lines ----------------------------------------------------
  appEntry(l) {
    const key = l.pid + ':' + l.tid;
    const last = this.lastUnity.get(key);
    if (last && l.t - last.t < 1500 && isFrame(l.msg) && l.tag === last.tag) {
      (last.stack = last.stack || []).push(l.msg);
      last.t2 = l.t;
      this.emit('stack', { id: last.id, line: l.msg });
      return null;
    }
    const e = { id: this.nextId++, t: l.t, pid: l.pid, tid: l.tid, lvl: l.lvl, tag: l.tag, msg: l.msg };
    this.lastUnity.set(key, e);
    this.entries.push(e);
    if (this.entries.length > 260000) this.entries.splice(0, 10000);
    this.classify(e);
    return e;
  }

  classify(e, replay) {
    if (e.lvl === 'E' || e.lvl === 'F') {
      if (!replay) this.counts.errors++;
      if (this.cur) this.cur.errors++;
      if (!replay && /\b[A-Z]\w*Exception\b/.test(e.msg)) this.counts.exceptions++;
      const sig = e.tag + '|' + e.msg.replace(/0x[0-9a-f]+/gi, '#').replace(/\d+/g, '#').slice(0, 140);
      const g = this.errGroups.get(sig);
      if (g) { g.count++; g.lastT = e.t; if (this.cur) g.levels.add(this.cur.id); }
      else this.errGroups.set(sig, { sig, count: 1, firstT: e.t, lastT: e.t, entry: e, levels: new Set(this.cur ? [this.cur.id] : []) });
    } else if (e.lvl === 'W') {
      if (!replay) this.counts.warnings++;
      if (this.cur) this.cur.warnings++;
    }
    let m;
    if ((m = this.re.start.exec(e.msg))) this.openAttempt(firstGroup(m), e.t);
    else if ((m = this.re.end.exec(e.msg))) this.endAttempt(firstGroup(m), e.t, 'complete');
    else if ((m = this.re.fail.exec(e.msg))) this.endAttempt(firstGroup(m), e.t, 'fail');
    else if ((m = this.re.event.exec(e.msg))) {
      const name = m[1].trim();
      this.appEvents.push({ t: e.t, name, level: this.cur ? this.cur.id : null });
      this.addTimeline(e.t, 'event', name);
    }
  }

  openAttempt(id, t) {
    if (!id) return;
    if (this.cur) this.closeAttempt(this.cur.id === id ? 'restarted' : 'abandoned', t);
    const n = this.attempts.filter((a) => a.id === id).length + 1;
    this.cur = {
      id, n, start: t, end: null, duration: null, outcome: 'open', errors: 0, warnings: 0, crashes: 0, anrs: 0,
      gapBefore: this.lastEnd !== null ? t - this.lastEnd : null,
    };
    this.attempts.push(this.cur);
    this.addTimeline(t, 'level', `Level ${id} started (attempt ${n})`);
    this.emit('level', { phase: 'start', t, attempt: this.cur });
  }

  endAttempt(id, t, outcome) {
    if (!this.cur || this.cur.id !== id) {
      this.addTimeline(t, 'warn', `Level ${id} ${outcome} log without matching start`);
      return;
    }
    this.closeAttempt(outcome, t);
  }

  closeAttempt(outcome, t) {
    const a = this.cur;
    if (!a) return;
    a.end = t;
    a.duration = Math.max(0, t - a.start);
    a.outcome = outcome;
    if (outcome === 'complete' || outcome === 'fail') this.lastEnd = t;
    this.cur = null;
    this.addTimeline(t, 'level', `Level ${a.id} ${outcome} after ${(a.duration / 1000).toFixed(1)}s`);
    this.emit('level', { phase: 'end', t, attempt: a });
  }

  addTimeline(t, kind, text) {
    this.timeline.push({ t, kind, text });
    if (this.timeline.length > 5500) this.timeline.splice(0, 500);
  }

  // Recompute level data from stored entries (used when the user edits level regexes).
  reanalyze(rules) {
    this.setRules(rules);
    this.reset();
    const crashes = [...this.crashes].sort((a, b) => a.t - b.t);
    let ci = 0;
    const applyCrash = (c) => {
      c.level = this.cur ? this.cur.id : null;
      if (c.type === 'died' && c.kind === 'closed') { if (this.cur) this.closeAttempt('abandoned', c.t); }
      else this.noteInLevel(c);
      this.addTimeline(c.t, c.type, c.summary);
    };
    for (const e of this.entries) {
      while (ci < crashes.length && crashes[ci].t <= e.t) applyCrash(crashes[ci++]);
      this.classify(e, true);
    }
    while (ci < crashes.length) applyCrash(crashes[ci++]);
  }

  // ---- summary ----------------------------------------------------------
  summary() {
    const order = [];
    const by = new Map();
    for (const a of this.attempts) {
      if (!by.has(a.id)) { by.set(a.id, []); order.push(a.id); }
      by.get(a.id).push(a);
    }
    const med = (arr) => { if (!arr.length) return null; const s = [...arr].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const avg = (arr) => (arr.length ? Math.round(arr.reduce((x, y) => x + y, 0) / arr.length) : null);
    const levels = order.map((id) => {
      const list = by.get(id);
      const won = list.filter((a) => a.outcome === 'complete').map((a) => a.duration);
      const lost = list.filter((a) => a.outcome === 'fail').map((a) => a.duration);
      const cnt = (o) => list.filter((a) => a.outcome === o).length;
      return {
        id, attempts: list.length, completed: won.length, failed: lost.length,
        abandoned: cnt('abandoned') + cnt('restarted'), crashed: cnt('crashed') + cnt('killed'),
        anrs: list.reduce((s, a) => s + a.anrs, 0),
        avgMs: avg(won), medianMs: med(won), minMs: won.length ? Math.min(...won) : null, maxMs: won.length ? Math.max(...won) : null,
        avgGapMs: avg(list.filter((x) => x.gapBefore != null).map((x) => x.gapBefore)),
        avgFailMs: avg(lost), errors: list.reduce((s, a) => s + a.errors, 0), warnings: list.reduce((s, a) => s + a.warnings, 0),
      };
    });
    const real = this.crashes.filter((c) => c.type === 'crash');
    const anrs = this.crashes.filter((c) => c.type === 'anr');
    const died = this.crashes.filter((c) => c.type === 'died' && c.kind === 'killed');
    const topErrors = [...this.errGroups.values()].sort((a, b) => b.count - a.count).slice(0, 40).map((g) => ({
      sig: g.sig, tag: g.entry.tag, message: g.entry.msg, count: g.count, firstT: g.firstT, lastT: g.lastT,
      stack: g.entry.stack || [], levels: [...g.levels],
    }));
    const done = this.attempts.filter((x) => x.end);
    const gaps = this.attempts.filter((x) => x.gapBefore != null).map((x) => x.gapBefore);
    const levelTotals = {
      inLevelMs: done.reduce((s, x) => s + x.duration, 0),
      gapCount: gaps.length,
      gapTotalMs: gaps.reduce((s, x) => s + x, 0),
      gapAvgMs: gaps.length ? Math.round(gaps.reduce((s, x) => s + x, 0) / gaps.length) : null,
      gapMaxMs: gaps.length ? Math.max(...gaps) : null,
    };
    const processes = [...this.procs.values()].sort((x, y) => x.firstT - y.firstT).map((p) => ({ ...p, duration: p.lastT - p.firstT }));
    return {
      levelTotals, processes,
      counts: { ...this.counts, crashes: real.length, anrs: anrs.length, killed: died.length },
      crashFree: real.length + anrs.length + died.length === 0,
      startupMs: this.startupMs,
      firstT: this.firstT, lastT: this.lastT,
      currentLevel: this.cur ? this.cur.id : null,
      levels,
      attempts: this.attempts,
      incidents: this.crashes.filter((c) => !(c.type === 'died' && c.kind === 'closed')),
      topErrors,
      appEvents: this.appEvents,
      timeline: this.timeline.slice(-800),
      rules: this.rules,
    };
  }
}

module.exports = { Analyzer, DEFAULT_RULES };
