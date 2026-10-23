const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');
const adb = require('./lib/adb');
const { inspectApk } = require('./lib/apk');
const { Session, listSessions, loadSession, deleteSession } = require('./lib/session');
const { renderReport, textSummary } = require('./lib/report');
const { DEFAULT_RULES } = require('./lib/analyzer');
const { friendly } = require('./lib/hints');

const PORT = +process.env.PORT || 7878;
const PUB = path.join(__dirname, 'public');
const { DATA } = require('./lib/paths');
const UPLOADS = path.join(DATA, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });
// uploaded APKs are large; drop the ones older than a week
for (const f of fs.readdirSync(UPLOADS)) {
  try { if (Date.now() - fs.statSync(path.join(UPLOADS, f)).mtimeMs > 7 * 86400000) fs.unlinkSync(path.join(UPLOADS, f)); } catch (_) { /* ignore */ }
}

let current = null; // the live Session
const RULES_FILE = path.join(DATA, 'rules.json');
let rules = { ...DEFAULT_RULES };
try { rules = { ...DEFAULT_RULES, ...JSON.parse(fs.readFileSync(RULES_FILE, 'utf8')) }; } catch (_) { /* first run */ }
const clients = new Set();

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.cs': 'text/plain', '.svg': 'image/svg+xml' };
const send = (res, code, body, type = 'application/json', extra = {}) => {
  res.writeHead(code, { 'Content-Type': type + (type.startsWith('text') || type.includes('json') ? '; charset=utf-8' : ''), 'Cache-Control': 'no-store', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readJson = (req) => new Promise((resolve) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); } });
});
const broadcast = (payload) => {
  const s = `data: ${JSON.stringify(payload)}\n\n`;
  for (const c of clients) c.write(s);
};

function attach(session) {
  session.on('batch', (b) => broadcast({ k: 'batch', v: b }));
  session.on('msg', (m) => broadcast(m));
}

function reportData(id) {
  if (id === 'live') {
    if (!current) return null;
    return { meta: current.meta(), summary: current.analyzer.summary() };
  }
  return loadSession(id);
}

const os = require('os');
const { execFile } = require('child_process');
const LAST_FILE = path.join(DATA, 'lastdevice.json');
let lastAddr = null;
try { lastAddr = JSON.parse(fs.readFileSync(LAST_FILE, 'utf8')).addr; } catch (_) { /* none yet */ }
function rememberAddr(a) { lastAddr = a; try { fs.writeFileSync(LAST_FILE, JSON.stringify({ addr: a })); } catch (_) { /* ignore */ } }

function otherAdbServers() {
  return new Promise((res) => execFile('ps', ['-axo', 'command='], { timeout: 4000 }, (e, out) => {
    const mine = adb.path;
    const found = new Set();
    for (const line of String(out || '').split('\n')) {
      const m = /^(.*?adb)\s+(?:-L\s+\S+\s+)?(?:fork-server|server)\b/.exec(line.trim());
      // ps shows just "adb" for our own server; only a full path can be told apart
      if (m && m[1].includes('/') && m[1] !== mine) found.add(m[1]);
    }
    res([...found]);
  }));
}

// Plain-language connection check: what the Mac can see, and what to do about it.
async function doctor() {
  const checks = [];
  const add = (ok, title, detail) => checks.push({ ok, title, detail });
  if (!adb.path) { add(false, 'adb tool', 'Not found. Use "Download adb" on the left.'); return { checks, advice: ['Download adb first.'] }; }
  const devs = await adb.devices();
  const ready = devs.filter((d) => d.state === 'device');
  add(true, 'adb tool', 'Working.');
  add(ready.length > 0, 'Phone connected', ready.length ? ready.map((d) => d.model || d.serial).join(', ') : 'No phone is connected right now.');
  const unauth = devs.filter((d) => d.state === 'unauthorized');
  if (unauth.length) add(false, 'USB permission', 'Phone is asking "Allow USB debugging?" - tap Allow on the phone.');
  const others = await otherAdbServers();
  if (others.length) add(false, 'Another adb is running', `${others[0]} - it can fight with this tool and drop the phone.`);
  const m = await adb.run(['mdns', 'services'], { timeout: 8000 });
  const found = m.out.split('\n').filter((l) => /_adb-tls-(connect|pairing)/.test(l));
  add(found.length > 0, 'Phone visible on Wi-Fi', found.length ? `${found.length} wireless debugging service(s) seen.` : 'The Mac cannot see any phone announcing Wireless debugging.');
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address);
  add(ips.length > 0, 'Mac network', ips.length ? ips.join(', ') : 'Mac is not on any network.');
  let unreachable = false;
  if (lastAddr && !ready.length) {
    const [ip, port] = lastAddr.split(':');
    const r = await new Promise((res) => execFile('nc', ['-z', '-w', '3', ip, port], { timeout: 6000 }, (e, so, se) => res({ ok: !e, err: String(se || (e && e.message) || '') })));
    unreachable = !r.ok;
    add(r.ok, 'Last phone address', r.ok ? `${lastAddr} answers (connect again with the Connect button).` : `${lastAddr} does not answer${/no route/i.test(r.err) ? ' (macOS blocked it)' : ''}.`);
    const toInt = (a) => a.split('.').reduce((n, x) => (n * 256 + (+x)), 0);
    const nics = Object.values(os.networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal);
    const same = nics.some((i) => { const mask = toInt(i.netmask); return ((toInt(i.address) & mask) >>> 0) === ((toInt(ip) & mask) >>> 0); });
    if (!same && nics.length) add(false, 'Same network?', `Phone was at ${ip}, Mac is at ${nics[0].address}. They are on different networks.`);
    if (/no route/i.test(r.err)) unreachable = 'blocked';
  }
  const advice = [];
  if (others.length) advice.push('Quit Android Studio / Unity Android tools that use another adb, or run: ' + adb.path + ' kill-server');
  if (!ready.length) {
    if (unreachable === 'blocked') advice.push('System Settings > Privacy & Security > Local Network: switch ON for Unity Logcat PM (or Terminal). Then reopen the tool.');
    advice.push('Phone and Mac must be on the SAME Wi-Fi (not guest/office Wi-Fi).');
    advice.push('On the phone: turn Wireless debugging OFF then ON. It switches itself off when Wi-Fi changes.');
    advice.push('Then press "Pair with QR code" again (old pairing is lost when the network changes).');
    advice.push('Fastest fix: plug in the USB cable and tap Allow on the phone.');
  } else advice.push('All good - pick the build and start a session.');
  return { checks, advice };
}

let qr = null;
async function qrLoop(job) {
  const t0 = Date.now();
  while (qr === job && Date.now() - t0 < 180000 && job.state !== 'connected') {
    const r = await adb.run(['mdns', 'services'], { timeout: 8000 });
    const svc = r.out.split('\n').map((l) => l.trim().split(/\s+/)).filter((x) => x.length >= 3);
    if (job.state === 'waiting') {
      const p = svc.find((x) => x[1].startsWith('_adb-tls-pairing') && x[0] === job.name);
      if (p) {
        job.state = 'pairing';
        const pr = await adb.pair(p[2], job.password);
        if (/Successfully/.test(pr.out)) { job.state = 'paired'; job.host = p[2].split(':')[0]; }
        else { job.state = 'waiting'; job.msg = (pr.out + pr.err).trim(); }
      }
    }
    if (job.state === 'paired') {
      const c = svc.find((x) => x[1].startsWith('_adb-tls-connect') && x[2].startsWith(job.host + ':'));
      if (c) {
        const cr = await adb.connect(c[2]);
        if (/connected/.test(cr.out) && !/failed/.test(cr.out)) { job.state = 'connected'; rememberAddr(c[2]); }
      }
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  if (qr === job && job.state !== 'connected') job.state = 'timeout';
}

async function withHw(list) {
  await Promise.all(list.filter((d) => d.state === 'device').map(async (d) => { d.hw = await adb.hwSerial(d.serial); }));
  return list;
}

const routes = {
  'POST /api/qr/start': async () => {
    const id = Math.random().toString(36).slice(2, 7);
    qr = { name: 'unitypm-' + id, password: String(Math.floor(100000 + Math.random() * 900000)), state: 'waiting', msg: '' };
    qrLoop(qr);
    return { payload: `WIFI:T:ADB;S:${qr.name};P:${qr.password};;` };
  },
  'GET /api/qr/status': async () => ({ state: qr ? qr.state : 'none', msg: qr ? qr.msg : '' }),

  'GET /api/status': async () => ({
    adb: adb.path ? { path: adb.path, version: await adb.version() } : null,
    devices: adb.path ? await withHw(await adb.devices()) : [],
    session: current ? { ...current.meta(), stats: current.liveStats() } : null,
    rules,
    defaultRules: DEFAULT_RULES,
  }),

  'POST /api/setup-adb': async () => {
    const script = path.join(__dirname, 'setup-adb.sh');
    const out = await new Promise((resolve) => exec(`bash "${script}"`, { timeout: 180000 }, (e, so, se) => resolve((so + se).trim() + (e ? '\nFAILED' : ''))));
    adb.findAdb();
    return { ok: !!adb.path, msg: out.split('\n').slice(-4).join('\n') };
  },

  'GET /api/doctor': async () => doctor(),
  'POST /api/connect': async (req, body) => {
    const r = await adb.connect(body.addr);
    const ok = /connected/.test(r.out) && !/failed|cannot/.test(r.out);
    if (ok) rememberAddr(body.addr);
    const msg = (r.out + r.err).trim();
    return { ok, msg, hint: ok ? null : friendly('connect', msg) };
  },
  'POST /api/pair': async (req, body) => {
    const r = await adb.pair(body.addr, body.code);
    const ok = /Successfully/.test(r.out), msg = (r.out + r.err).trim();
    return { ok, msg, hint: ok ? null : friendly('pair', msg) };
  },
  'POST /api/go-wireless': async (req, body) => { const r = await adb.goWireless(body.serial); if (r.ok && r.ip) rememberAddr(r.ip + ':5555'); return r; },
  'POST /api/disconnect': async (req, body) => { await adb.disconnect(body.addr); return { ok: true }; },

  'GET /api/packages': async (req, body, q) => ({ packages: await adb.thirdPartyPackages(q.serial, q.all === '1') }),
  'GET /api/package-info': async (req, body, q) => adb.packageInfo(q.serial, q.pkg),

  'POST /api/inspect': async (req, body) => {
    try { return { ok: true, apk: inspectApk(body.path) }; } catch (e) { return { ok: false, msg: e.message }; }
  },

  'POST /api/install': async (req, body) => {
    const r = await adb.install(body.serial, body.path, { clean: body.clean, pkg: body.pkg });
    if (!r.ok) r.hint = friendly('install', r.msg);
    return r;
  },

  'POST /api/app/launch': async (req, body) => { await adb.launch(body.serial, body.pkg); return { ok: true }; },
  'POST /api/app/stop': async (req, body) => { await adb.forceStop(body.serial, body.pkg); return { ok: true }; },

  'POST /api/session/start': async (req, body) => {
    if (current && !current.stopped) await current.stop();
    const device = await adb.deviceInfo(body.serial);
    current = new Session({ serial: body.serial, pkg: body.pkg, device, build: body.build, rules });
    attach(current);
    await current.start({ clear: body.clear !== false, launch: body.launch !== false });
    broadcast({ k: 'reset', v: current.snapshot() });
    return { ok: true, id: current.id };
  },
  'POST /api/session/stop': async () => {
    if (!current) return { ok: false };
    await current.stop();
    return { ok: true, id: current.id };
  },
  'POST /api/session/scope': async (req, body) => { if (current) current.broadcastAll = !!body.all; return { ok: true }; },

  'POST /api/rules': async (req, body) => {
    rules = { ...DEFAULT_RULES, ...body.rules };
    try { fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2)); } catch (_) { /* ignore */ }
    if (current) current.reanalyze(rules);
    return { ok: true, rules };
  },

  'GET /api/sessions': async () => ({ sessions: listSessions() }),
};

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const PKG_RE = /^[A-Za-z][\w]*(\.[\w]+)+$/;       // com.company.game
const SERIAL_RE = /^[\w.:\-\[\]]{1,128}$/;       // USB serial, ip:port, adb-xxx._adb-tls-connect._tcp
const bad = (m) => { const e = new Error(m); e.status = 400; return e; };
function validate(body, q) {
  const g = (k) => (body[k] !== undefined ? body[k] : q[k]);
  if (g('serial') !== undefined && !SERIAL_RE.test(String(g('serial')))) throw bad('invalid device serial');
  if (g('pkg') !== undefined && !PKG_RE.test(String(g('pkg')))) throw bad('invalid package name');
  if (body.addr !== undefined && !/^[\w.\-]+:\d{1,5}$/.test(String(body.addr))) throw bad('invalid address (expected ip:port)');
  if (body.path !== undefined) {
    const p = path.resolve(String(body.path));
    if (!p.startsWith(UPLOADS + path.sep)) throw bad('file must be an uploaded APK');
    body.path = p;
  }
}

const server = http.createServer(async (req, res) => {
  // Block other websites (CSRF) and DNS-rebinding: only accept requests addressed to localhost
  const origin = req.headers.origin;
  if (!LOCAL_HOST.test(req.headers.host || '') || (origin && !LOCAL_HOST.test(origin.replace(/^https?:\/\//, '')))) {
    return send(res, 403, { ok: false, msg: 'forbidden' });
  }
  const url = new URL(req.url, 'http://x');
  const q = Object.fromEntries(url.searchParams);
  try {
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      clients.add(res);
      req.on('close', () => clients.delete(res));
      res.write(`data: ${JSON.stringify({ k: 'reset', v: current ? current.snapshot() : null })}\n\n`);
      const ka = setInterval(() => res.write(': ka\n\n'), 20000);
      req.on('close', () => clearInterval(ka));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const name = path.basename(q.name || 'build.apk').replace(/[^\w.\-]/g, '_');
      const dest = path.join(UPLOADS, Date.now() + '-' + name);
      const hash = crypto.createHash('sha256');
      const ws = fs.createWriteStream(dest);
      req.on('data', (d) => hash.update(d));
      req.pipe(ws);
      ws.on('error', (e) => send(res, 500, { ok: false, msg: e.message }));
      ws.on('finish', () => {
        const sha256 = hash.digest('hex');
        try {
          const apk = inspectApk(dest);
          send(res, 200, { ok: true, apk: { ...apk, sha256, name } });
        } catch (e) {
          // still installable; package name is then discovered by diffing installed apps
          send(res, 200, { ok: true, apk: { file: dest, name, size: fs.statSync(dest).size, sha256, package: null, parseError: e.message } });
        }
      });
      return;
    }

    let m;
    if ((m = /^\/api\/report\/([^/]+)\.(html|txt|json)$/.exec(url.pathname))) {
      const data = reportData(decodeURIComponent(m[1]));
      if (!data) return send(res, 404, { error: 'no such session' });
      if (m[2] === 'html') {
        const dl = q.download ? { 'Content-Disposition': `attachment; filename="report-${data.meta.pkg}-${new Date(data.meta.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.html"` } : {};
        return send(res, 200, renderReport(data, q.theme), 'text/html', dl);
      }
      if (m[2] === 'txt') return send(res, 200, textSummary(data), 'text/plain');
      return send(res, 200, data);
    }
    if ((m = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname))) {
      if (req.method === 'DELETE') { deleteSession(decodeURIComponent(m[1])); return send(res, 200, { ok: true }); }
      return send(res, 200, loadSession(decodeURIComponent(m[1])));
    }

    const handler = routes[`${req.method} ${url.pathname}`];
    if (handler) {
      const body = req.method === 'POST' ? await readJson(req) : {};
      validate(body, q);
      return send(res, 200, await handler(req, body, q));
    }

    // static
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    const rel = file.startsWith('/unity/') ? path.join(__dirname, file) : path.join(PUB, file);
    if (!rel.startsWith(PUB) && !rel.startsWith(path.join(__dirname, 'unity'))) return send(res, 403, 'forbidden', 'text/plain');
    if (!fs.existsSync(rel) || fs.statSync(rel).isDirectory()) return send(res, 404, 'not found', 'text/plain');
    return send(res, 200, fs.readFileSync(rel), MIME[path.extname(rel)] || 'application/octet-stream');
  } catch (e) {
    console.error(e);
    send(res, e.status || 500, { ok: false, msg: String(e.message || e) });
  }
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use - is Unity Logcat PM already running? (stop it with: pkill -f "node server.js")` : e.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Unity Logcat PM running at http://localhost:${PORT}`);
  console.log(adb.path ? `adb: ${adb.path}` : 'adb: NOT FOUND (the UI will offer to download it)');
  if (!process.env.NO_OPEN && process.platform === 'darwin') spawn('open', [`http://localhost:${PORT}`], { stdio: 'ignore' }).unref();
});

// Quit by itself when the browser tab is closed (and nothing is recording), so the app needs no "Quit" step.
let idle = 0;
setInterval(() => {
  idle = clients.size === 0 && !(current && !current.stopped) ? idle + 30 : 0;
  if (idle >= 180 && process.env.AUTO_QUIT) { console.log('No browser tab open - exiting.'); process.exit(0); }
}, 30000).unref();

process.on('SIGINT', async () => { if (current && !current.stopped) await current.stop(); process.exit(0); });
