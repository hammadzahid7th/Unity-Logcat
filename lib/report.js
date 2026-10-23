// Self-contained HTML build/test report + short text summary (for pasting into Slack/Jira).

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dur = (ms) => {
  if (ms == null) return '-';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 's';
  const m = Math.floor(s / 60);
  return m + 'm ' + String(Math.round(s - m * 60)).padStart(2, '0') + 's';
};
const clock = (t) => (t ? new Date(t).toISOString().slice(11, 19) : '-');
const when = (t) => (t ? new Date(t).toLocaleString() : '-');

function sparkline(samples) {
  if (!samples || samples.length < 2) return '<span class="muted">not enough samples</span>';
  const W = 560, H = 70;
  const xs = samples.map((s) => s[0]), ys = samples.map((s) => s[1] / 1024);
  const x0 = xs[0], x1 = xs[xs.length - 1] || x0 + 1;
  const lo = Math.min(...ys), hi = Math.max(...ys, lo + 1);
  const pts = samples.map((s, i) => `${((xs[i] - x0) / (x1 - x0 || 1) * W).toFixed(1)},${(H - ((ys[i] - lo) / (hi - lo)) * (H - 8) - 4).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none"><polyline fill="none" stroke="#4aa3ff" stroke-width="2" points="${pts}"/></svg>
  <div class="muted">min ${lo.toFixed(0)} MB - peak ${hi.toFixed(0)} MB (PSS)</div>`;
}

function verdict(sum) {
  const c = sum.counts;
  if (c.crashes || c.anrs || c.killed) return { cls: 'bad', text: `${c.crashes} crash${c.crashes === 1 ? '' : 'es'}, ${c.anrs} ANR${c.anrs === 1 ? '' : 's'}${c.killed ? `, ${c.killed} unexpected kill${c.killed === 1 ? '' : 's'}` : ''}` };
  if (c.exceptions) return { cls: 'warn', text: `Stable, but ${c.exceptions} script exception${c.exceptions === 1 ? '' : 's'} logged` };
  return { cls: 'ok', text: 'Stable - no crashes or ANRs' };
}

function renderReport(data, theme) {
  const { meta, summary: s } = data;
  const v = verdict(s);
  const b = meta.build || {};
  const d = meta.device || {};
  const mem = meta.memory || [];
  const peak = mem.length ? Math.max(...mem.map((m) => m[1])) / 1024 : null;
  const sessionMs = (meta.endedAt || Date.now()) - meta.startedAt;
  const lvlRows = s.levels.map((l) => `<tr>
    <td><b>${esc(l.id)}</b></td><td>${l.attempts}</td><td>${l.completed}</td><td>${l.failed}</td><td>${l.abandoned}</td>
    <td class="${l.crashed ? 'badc' : ''}">${l.crashed}</td><td class="${l.anrs ? 'badc' : ''}">${l.anrs}</td>
    <td>${dur(l.avgMs)}</td><td>${dur(l.avgGapMs)}</td><td>${dur(l.medianMs)}</td><td>${dur(l.minMs)} / ${dur(l.maxMs)}</td><td>${dur(l.avgFailMs)}</td><td>${l.errors}</td></tr>`).join('');
  const maxAvg = Math.max(1, ...s.levels.map((l) => l.avgMs || 0));
  const bars = s.levels.filter((l) => l.avgMs).map((l) =>
    `<div class="bar"><span class="bl">Level ${esc(l.id)}</span><span class="bf" style="width:${(l.avgMs / maxAvg * 100).toFixed(1)}%"></span><span class="bv">${dur(l.avgMs)}</span></div>`).join('');
  const attemptRows = s.attempts.map((a) => `<tr><td>${esc(a.id)}</td><td>#${a.n}</td><td>${clock(a.start)}</td><td>${dur(a.duration)}</td>
    <td class="o-${a.outcome}">${esc(a.outcome)}</td><td>${a.gapBefore == null ? '-' : dur(a.gapBefore)}</td><td>${a.errors}</td></tr>`).join('');

  const incidents = s.incidents.map((c) => {
    const label = c.type === 'anr' ? 'ANR' : c.type === 'died' ? 'KILLED' : c.kind === 'native' ? 'NATIVE CRASH' : 'CRASH';
    return `<details class="inc ${c.type}" open><summary><span class="tag">${label}</span> ${esc(c.summary)}
      <span class="muted">${clock(c.t)}${c.level != null ? ' - during Level ' + esc(c.level) : ''}${c.pid ? ' - pid ' + c.pid : ''}</span></summary>
      <pre>${esc(c.text || '')}</pre>${c.traces ? `<details><summary>ANR thread dump (dropbox)</summary><pre>${esc(c.traces)}</pre></details>` : ''}</details>`;
  }).join('') || '<p class="muted">No crashes, ANRs or unexpected kills in this session.</p>';

  const errs = s.topErrors.map((e) => `<details class="err"><summary><span class="cnt">${e.count}x</span> <span class="muted">[${esc(e.tag)}]</span> ${esc(e.message.slice(0, 220))}
    ${e.levels.length ? `<span class="muted"> - levels: ${esc(e.levels.join(', '))}</span>` : ''}</summary>
    <pre>${esc([e.message, ...e.stack].join('\n'))}</pre></details>`).join('') || '<p class="muted">No error-level logs.</p>';

  const events = s.appEvents.length ? `<h2>Custom events</h2><table><tr><th>Time</th><th>Event</th><th>Level</th></tr>${s.appEvents.slice(-200).map((e) =>
    `<tr><td>${clock(e.t)}</td><td>${esc(e.name)}</td><td>${esc(e.level ?? '-')}</td></tr>`).join('')}</table>` : '';

  return `<!doctype html><html${theme === 'light' || theme === 'dark' ? ` data-theme="${theme}"` : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 64 64%22%3E  %3Crect width=%2264%22 height=%2264%22 rx=%2214%22 fill=%22%230b63ce%22/%3E  %3Crect x=%2220%22 y=%229%22 width=%2224%22 height=%2246%22 rx=%225%22 fill=%22none%22 stroke=%22%23fff%22 stroke-width=%223%22/%3E  %3Cpath d=%22M25 34h3l3-9 5 17 3-8h1%22 fill=%22none%22 stroke=%22%23fff%22 stroke-width=%223%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22/%3E%3C/svg%3E">
<title>Build report - ${esc(meta.pkg)}</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1d1f23;--mut:#666c75;--head:#f3f4f6;--line:#d8dbe0;--acc:#0b63ce;--ok:#1d7a3e;--warn:#946200;--bad:#c4262e;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#1c1d20;--fg:#dcdee2;--mut:#9399a2;--head:#26282c;--line:#3a3d43;--acc:#5b9df0;--ok:#62b97d;--warn:#d6a23f;--bad:#ef7770}}
:root[data-theme=dark]{--bg:#1c1d20;--fg:#dcdee2;--mut:#9399a2;--head:#26282c;--line:#3a3d43;--acc:#5b9df0;--ok:#62b97d;--warn:#d6a23f;--bad:#ef7770}
:root[data-theme=light]{color-scheme:light}
*{box-sizing:border-box}body{margin:0;padding:24px 28px 60px;background:var(--bg);color:var(--fg);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:960px;margin:auto}
h1{font-size:18px;font-weight:600;margin:0 0 2px}h2{font-size:14px;font-weight:600;margin:28px 0 8px}
.muted{color:var(--mut)}
.banner{margin:14px 0;padding:8px 12px;border-left:3px solid var(--ok);background:var(--head);font-weight:600}
.banner.warn{border-left-color:var(--warn)}.banner.bad{border-left-color:var(--bad);color:var(--bad)}
.grid{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--line);border-right:0;border-bottom:0}
.card{padding:8px 12px;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}
.card .muted{display:block;font-size:12px}.card b{display:block;font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}
@media(max-width:700px){.grid{grid-template-columns:repeat(2,1fr)}}
.kv{display:grid;grid-template-columns:150px 1fr;gap:3px 12px}.kv div:nth-child(odd){color:var(--mut)}
table{width:100%;border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line)}th{background:var(--head);color:var(--mut);font-weight:600;border-top:1px solid var(--line)}
tr:hover td{background:var(--head)}
.badc{color:var(--bad);font-weight:600}.o-complete{color:var(--ok)}.o-fail,.o-abandoned,.o-restarted{color:var(--warn)}.o-crashed,.o-killed{color:var(--bad);font-weight:600}
.bar{display:flex;align-items:center;gap:8px;margin:2px 0}.bl{width:70px;color:var(--mut)}.bf{height:10px;background:var(--acc);min-width:2px}.bv{font-variant-numeric:tabular-nums}
pre{background:var(--head);border:1px solid var(--line);padding:8px 10px;overflow:auto;font:11.5px/1.45 var(--mono);max-height:400px;white-space:pre-wrap;word-break:break-word;margin:6px 0}
details.inc,details.err{border-top:1px solid var(--line);padding:6px 0}details.inc:last-child,details.err:last-child{border-bottom:1px solid var(--line)}
summary{cursor:pointer}
.tag{color:var(--bad);font:600 11px var(--mono);margin-right:6px}.inc.anr .tag{color:var(--warn)}
.cnt{font:600 11.5px var(--mono);margin-right:6px}
@media print{details{break-inside:avoid}}
</style></head><body><div class="wrap">
<h1>${esc(meta.pkg)} <span class="muted">v${esc(b.versionName || '?')} (${esc(b.versionCode || '?')})</span></h1>
<div class="muted">Test session ${esc(when(meta.startedAt))} - ${dur(sessionMs)} - ${esc(d.manufacturer || '')} ${esc(d.model || '')} - Android ${esc(d.android || '?')}</div>
<div class="banner ${v.cls}">${esc(v.text)}</div>
<div class="grid">
<div class="card"><span class="muted">Crashes</span><b>${s.counts.crashes}</b></div>
<div class="card"><span class="muted">ANRs</span><b>${s.counts.anrs}</b></div>
<div class="card"><span class="muted">Unexpected kills</span><b>${s.counts.killed}</b></div>
<div class="card"><span class="muted">Errors / exceptions</span><b>${s.counts.errors} / ${s.counts.exceptions}</b></div>
<div class="card"><span class="muted">Warnings</span><b>${s.counts.warnings}</b></div>
<div class="card"><span class="muted">Cold start</span><b>${s.startupMs != null ? dur(s.startupMs) : '-'}</b></div>
<div class="card"><span class="muted">Levels played</span><b>${s.levels.length}</b></div>
<div class="card"><span class="muted">Peak memory</span><b>${peak ? peak.toFixed(0) + ' MB' : '-'}</b></div>
<div class="card"><span class="muted">Session time</span><b>${dur(sessionMs)}</b></div>
<div class="card"><span class="muted">Time inside levels</span><b>${dur(s.levelTotals.inLevelMs)}</b></div>
<div class="card"><span class="muted">Avg delay level to level</span><b>${dur(s.levelTotals.gapAvgMs)}</b></div>
<div class="card"><span class="muted">Longest delay</span><b>${dur(s.levelTotals.gapMaxMs)}</b></div>
</div>
${s.processes.length ? `<h2>App launches (each = one process)</h2><table><tr><th>#</th><th>Started</th><th>Duration</th><th>pid</th></tr>${s.processes.map((p, i) => `<tr><td>${i + 1}</td><td>${clock(p.firstT)}</td><td>${dur(p.duration)}</td><td>${p.pid}</td></tr>`).join('')}</table>` : ''}

<h2>Incidents (crashes, ANRs, kills)</h2>${incidents}

<h2>Level timings</h2>
${s.levels.length ? `<table><tr><th>Level</th><th>Tries</th><th>Won</th><th>Failed</th><th>Quit</th><th>Crashed</th><th>ANR</th><th>Avg time</th><th>Delay before</th><th>Median</th><th>Min / Max</th><th>Avg fail</th><th>Errors</th></tr>${lvlRows}</table>
<h2>Average time to complete</h2>${bars || '<p class="muted">No completed levels.</p>'}
<h2>Every attempt (in play order)</h2><table><tr><th>Level</th><th>Try</th><th>Start</th><th>Duration</th><th>Outcome</th><th>Gap since last level</th><th>Errors</th></tr>${attemptRows}</table>`
    : `<p class="muted">No level logs found. Ask the developer to log <code>[PM] LEVEL_START &lt;id&gt;</code> / <code>[PM] LEVEL_COMPLETE &lt;id&gt;</code> / <code>[PM] LEVEL_FAIL &lt;id&gt;</code> (see unity/PMLog.cs), or in the tool pick the Firebase event preset / adjust the patterns.</p>`}
${events}
<h2>Top errors (grouped, with stack)</h2>${errs}

<h2>Memory over time</h2>${sparkline(mem)}

<h2>Build &amp; device</h2>
<div class="kv">
<div>Package</div><div>${esc(meta.pkg)}</div>
<div>Version</div><div>${esc(b.versionName || '?')} (code ${esc(b.versionCode || '?')})</div>
<div>APK</div><div>${esc(b.name || '-')} ${b.size ? '- ' + (b.size / 1048576).toFixed(1) + ' MB' : ''}</div>
<div>Scripting backend</div><div>${esc(b.backend || '-')}</div>
<div>ABIs</div><div>${esc((b.abis || []).join(', ') || '-')}</div>
<div>SDK (min / target)</div><div>${esc(b.minSdk || '?')} / ${esc(b.targetSdk || '?')}</div>
<div>Debuggable</div><div>${b.debuggable ? 'Yes (development build)' : 'No'}</div>
<div>Device</div><div>${esc(d.manufacturer || '')} ${esc(d.model || '')}, ${esc(d.ramGb || '?')} GB RAM, ${esc(d.abi || '')}</div>
<div>Android</div><div>${esc(d.android || '?')} (API ${esc(d.sdk || '?')})</div>
<div>Log lines (app)</div><div>${s.counts.lines.toLocaleString()} total scanned</div>
</div>
${(meta.connection || []).length ? `<h2>Connection events</h2><ul>${meta.connection.map((c) => `<li>${esc(clock(c.t))} - ${esc(c.text)}</li>`).join('')}</ul>` : ''}
<p class="muted" style="margin-top:36px">Generated by Unity Logcat PM - ${esc(new Date().toLocaleString())}</p>
</div></body></html>`;
}

function textSummary(data) {
  const { meta, summary: s } = data;
  const b = meta.build || {}, d = meta.device || {};
  const lines = [
    `*${meta.pkg}* v${b.versionName || '?'} (${b.versionCode || '?'}) on ${d.manufacturer || ''} ${d.model || ''} (Android ${d.android || '?'})`,
    `Session: ${dur((meta.endedAt || Date.now()) - meta.startedAt)} - ${verdict(s).text}`,
    `Crashes ${s.counts.crashes} | ANRs ${s.counts.anrs} | Kills ${s.counts.killed} | Errors ${s.counts.errors} | Cold start ${s.startupMs != null ? dur(s.startupMs) : '-'}`,
  ];
  for (const c of s.incidents.slice(0, 8)) lines.push(`- ${c.type.toUpperCase()}${c.level != null ? ' (Level ' + c.level + ')' : ''}: ${c.summary}`);
  if (s.levels.length) {
    lines.push('Levels (avg win time):');
    for (const l of s.levels) lines.push(`  L${l.id}: ${dur(l.avgMs)} | tries ${l.attempts}, won ${l.completed}, failed ${l.failed}${l.crashed ? ', CRASHED ' + l.crashed : ''}${l.anrs ? ', ANR ' + l.anrs : ''}`);
  }
  return lines.join('\n');
}

module.exports = { renderReport, textSummary };
