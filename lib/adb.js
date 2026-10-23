const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { TOOLS } = require('./paths');
let ADB = null;

function candidates() {
  const home = os.homedir();
  const list = [process.env.ADB, path.join(TOOLS, 'platform-tools', 'adb')];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) list.push(path.join(dir, 'adb'));
  list.push(
    path.join(home, 'Library/Android/sdk/platform-tools/adb'),
    path.join(process.env.ANDROID_HOME || '/nonexistent', 'platform-tools/adb'),
    path.join(process.env.ANDROID_SDK_ROOT || '/nonexistent', 'platform-tools/adb'),
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb'
  );
  // Unity's bundled Android SDK (Unity Hub installs, any editor version)
  for (const base of ['/Applications/Unity/Hub/Editor', path.join(home, 'Applications/Unity/Hub/Editor')]) {
    try {
      for (const v of fs.readdirSync(base).sort().reverse()) {
        list.push(path.join(base, v, 'PlaybackEngines/AndroidPlayer/SDK/platform-tools/adb'));
      }
    } catch (_) { /* not installed */ }
  }
  return list.filter(Boolean);
}

function findAdb() {
  ADB = candidates().find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch (_) { return false; } }) || null;
  return ADB;
}
findAdb();

function run(args, { timeout = 20000, input } = {}) {
  return new Promise((resolve) => {
    if (!ADB) return resolve({ code: -1, out: '', err: 'adb not found' });
    const p = execFile(ADB, args, { timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (e, out, err) => {
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: out || '', err: (err || '') + (e && !err ? String(e.message) : '') });
    });
    if (input) p.stdin.end(input);
  });
}

const sh = (serial, cmd, opts) => run(['-s', serial, 'shell', cmd], opts);

async function version() {
  const r = await run(['version'], { timeout: 5000 });
  const m = /Android Debug Bridge version ([\d.]+)/.exec(r.out);
  return m ? m[1] : null;
}

async function devices() {
  const r = await run(['devices', '-l'], { timeout: 15000 });
  if (r.code !== 0 && !r.out) return [];
  return r.out.split('\n').slice(1).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [serial, state, ...rest] = l.split(/\s+/);
    const kv = Object.fromEntries(rest.map((x) => x.split(':')).filter((x) => x.length === 2));
    return {
      serial, state,
      model: (kv.model || '').replace(/_/g, ' '),
      product: kv.product || '',
      wifi: /^\d+\.\d+\.\d+\.\d+:\d+$/.test(serial) || serial.includes('_adb-tls'),
    };
  }).filter((d) => d.serial && d.state);
}

const connect = (addr) => run(['connect', addr], { timeout: 15000 });
const pair = (addr, code) => run(['pair', addr, code], { timeout: 20000 });
const disconnect = (addr) => run(['disconnect', addr], { timeout: 8000 });

async function goWireless(serial) {
  const r = await sh(serial, 'ip -f inet addr show wlan0');
  let ip = (/inet (\d+\.\d+\.\d+\.\d+)/.exec(r.out) || [])[1];
  if (!ip) {
    const r2 = await sh(serial, 'ip route');
    ip = (/src (\d+\.\d+\.\d+\.\d+)/.exec(r2.out) || [])[1];
  }
  if (!ip) return { ok: false, msg: 'Phone Wi-Fi IP not found. Is the phone connected to Wi-Fi?' };
  const t = await run(['-s', serial, 'tcpip', '5555'], { timeout: 10000 });
  await new Promise((res) => setTimeout(res, 1800));
  const c = await connect(`${ip}:5555`);
  const ok = /connected to/.test(c.out);
  return { ok, ip, msg: ok ? `Wireless ready at ${ip}:5555 - you can unplug the cable now.` : (c.out + c.err + t.err).trim() };
}

const hwCache = new Map();
// The phone's real hardware serial, so one phone seen over USB and Wi-Fi is shown once.
async function hwSerial(serial) {
  if (hwCache.has(serial)) return hwCache.get(serial);
  const r = await sh(serial, 'getprop ro.serialno', { timeout: 5000 });
  const v = r.out.trim();
  if (v) hwCache.set(serial, v);
  return v || null;
}

async function deviceInfo(serial) {
  const r = await sh(serial, 'getprop');
  const props = {};
  for (const l of r.out.split('\n')) {
    const m = /^\[(.+?)\]: \[(.*)\]$/.exec(l.trim());
    if (m) props[m[1]] = m[2];
  }
  const mem = await sh(serial, 'cat /proc/meminfo');
  const memKb = +((/MemTotal:\s+(\d+)/.exec(mem.out) || [])[1] || 0);
  return {
    serial,
    manufacturer: props['ro.product.manufacturer'] || '',
    model: props['ro.product.model'] || '',
    android: props['ro.build.version.release'] || '',
    sdk: props['ro.build.version.sdk'] || '',
    abi: props['ro.product.cpu.abi'] || '',
    ramGb: memKb ? +(memKb / 1048576).toFixed(1) : null,
    build: props['ro.build.display.id'] || '',
  };
}

// Returns [{name, updated}] - your installed apps first, newest update on top.
async function thirdPartyPackages(serial, all) {
  const parse = (o) => o.split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean);
  const user = parse((await sh(serial, 'pm list packages -3')).out);
  let names = all ? [...user, ...parse((await sh(serial, 'pm list packages')).out).filter((p) => !user.includes(p))] : user;
  // keep only apps with a launcher icon (hides background/service packages)
  const q = await sh(serial, 'cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER', { timeout: 20000 });
  const launchable = new Set(q.out.split('\n').map((l) => /^\s*([\w.]+)\//.exec(l)).filter(Boolean).map((m) => m[1]));
  if (launchable.size) names = names.filter((p) => launchable.has(p));
  const dump = (await sh(serial, 'dumpsys package packages', { timeout: 40000 })).out;
  const times = {};
  for (const blk of dump.split(/^\s*Package \[/m).slice(1)) {
    const n = blk.slice(0, blk.indexOf(']'));
    const m = /lastUpdateTime=(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/.exec(blk);
    if (m && !times[n]) times[n] = m[1];
  }
  const userSet = new Set(user);
  const rank = (p) => (userSet.has(p) ? 0 : 1);
  return names.map((name) => ({ name, updated: times[name] || '' }))
    .sort((x, y) => rank(x.name) - rank(y.name) || y.updated.localeCompare(x.updated) || x.name.localeCompare(y.name));
}

async function packageInfo(serial, pkg) {
  const r = await sh(serial, `dumpsys package ${pkg}`, { timeout: 20000 });
  const g = (re) => (re.exec(r.out) || [])[1] || null;
  return {
    package: pkg,
    installed: /Package \[/.test(r.out),
    versionName: g(/versionName=(\S+)/),
    versionCode: g(/versionCode=(\d+)/),
    installed_at: g(/lastUpdateTime=(.+)/),
  };
}

async function install(serial, file, { clean, pkg } = {}) {
  if (clean && pkg) await run(['-s', serial, 'uninstall', pkg], { timeout: 60000 });
  const r = await run(['-s', serial, 'install', '-r', '-d', '-t', file], { timeout: 15 * 60 * 1000 });
  const text = (r.out + r.err).trim();
  return { ok: /Success/.test(text), msg: text };
}

const launch = (serial, pkg) => sh(serial, `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
const forceStop = (serial, pkg) => sh(serial, `am force-stop ${pkg}`);
const clearLogcat = (serial) => run(['-s', serial, 'logcat', '-c'], { timeout: 8000 });

async function pids(serial, pkg) {
  const r = await sh(serial, `pidof ${pkg}`, { timeout: 6000 });
  let list = r.out.trim().split(/\s+/).filter((x) => /^\d+$/.test(x)).map(Number);
  if (!list.length && !r.out.trim()) {
    const p = await sh(serial, 'ps -A -o PID,NAME', { timeout: 6000 });
    list = p.out.split('\n').map((l) => l.trim().split(/\s+/)).filter((x) => x[1] === pkg || (x[1] || '').startsWith(pkg + ':')).map((x) => +x[0]);
  }
  return list;
}

async function memoryKb(serial, pkg) {
  const r = await sh(serial, `dumpsys meminfo ${pkg}`, { timeout: 10000 });
  const m = /TOTAL PSS:\s+(\d+)/.exec(r.out) || /^\s*TOTAL\s+(\d+)/m.exec(r.out);
  return m ? +m[1] : null;
}

// dumpsys dropbox holds the ANR trace (all thread stacks) without needing root.
async function lastAnrTrace(serial, pkg) {
  const r = await sh(serial, 'dumpsys dropbox --print data_app_anr', { timeout: 25000 });
  if (!r.out) return null;
  const chunks = r.out.split(/^={20,}\s*$/m).filter((c) => c.includes(pkg));
  const last = chunks[chunks.length - 1];
  return last ? last.trim().slice(0, 80000) : null;
}

function logcat(serial, sinceStr) {
  const args = ['-s', serial, 'logcat', '-v', 'threadtime', '-v', 'year', '-b', 'main', '-b', 'system', '-b', 'crash'];
  if (sinceStr) args.push('-T', sinceStr);
  return spawn(ADB, args);
}

module.exports = {
  findAdb, get path() { return ADB; }, version, devices, connect, pair, disconnect, goWireless, deviceInfo,
  thirdPartyPackages, packageInfo, hwSerial, install, launch, forceStop, clearLogcat, pids, memoryKb, lastAnrTrace, logcat, run, sh,
};
