// Minimal APK inspector: reads AndroidManifest.xml (binary XML) straight out of the zip,
// so we get package / version / debuggable without needing aapt.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

function zipEntries(fd, size) {
  const tailLen = Math.min(size, 66000);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);
  let e = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  }
  if (e < 0) throw new Error('Not a valid APK (zip directory not found)');
  const count = tail.readUInt16LE(e + 10);
  const cdSize = tail.readUInt32LE(e + 12);
  const cdOff = tail.readUInt32LE(e + 16);
  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOff);
  const out = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const nlen = cd.readUInt16LE(p + 28), elen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
    out.push({
      name: cd.toString('utf8', p + 46, p + 46 + nlen),
      method: cd.readUInt16LE(p + 10),
      csize: cd.readUInt32LE(p + 20),
      usize: cd.readUInt32LE(p + 24),
      lho: cd.readUInt32LE(p + 42),
    });
    p += 46 + nlen + elen + clen;
  }
  return out;
}

function zipRead(fd, ent) {
  const h = Buffer.alloc(30);
  fs.readSync(fd, h, 0, 30, ent.lho);
  const start = ent.lho + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  const data = Buffer.alloc(ent.csize);
  fs.readSync(fd, data, 0, ent.csize, start);
  return ent.method === 0 ? data : zlib.inflateRawSync(data);
}

function readPool(buf, off) {
  const count = buf.readUInt32LE(off + 8);
  const flags = buf.readUInt32LE(off + 16);
  const sStart = buf.readUInt32LE(off + 20);
  const utf8 = (flags & 0x100) !== 0;
  const out = [];
  for (let i = 0; i < count; i++) {
    let p = off + sStart + buf.readUInt32LE(off + 28 + i * 4);
    if (utf8) {
      if (buf[p++] & 0x80) p++;
      let bl = buf[p++];
      if (bl & 0x80) bl = ((bl & 0x7f) << 8) | buf[p++];
      out.push(buf.toString('utf8', p, p + bl));
    } else {
      let l = buf.readUInt16LE(p); p += 2;
      if (l & 0x8000) { l = ((l & 0x7fff) << 16) | buf.readUInt16LE(p); p += 2; }
      out.push(buf.toString('utf16le', p, p + l * 2));
    }
  }
  return out;
}

function parseManifest(buf) {
  let off = 8;
  let strings = [];
  const res = {};
  while (off + 8 <= buf.length) {
    const type = buf.readUInt16LE(off);
    const size = buf.readUInt32LE(off + 4);
    if (size < 8) break;
    if (type === 0x0001) strings = readPool(buf, off);
    else if (type === 0x0102) {
      const name = strings[buf.readUInt32LE(off + 20)];
      const attrStart = buf.readUInt16LE(off + 24);
      const attrCount = buf.readUInt16LE(off + 28);
      for (let i = 0; i < attrCount; i++) {
        const a = off + 16 + attrStart + i * 20;
        const an = strings[buf.readUInt32LE(a + 4)];
        const raw = buf.readInt32LE(a + 8);
        const dtype = buf.readUInt8(a + 15);
        const data = buf.readUInt32LE(a + 16);
        const val = raw >= 0 ? strings[raw] : (dtype === 0x12 ? data !== 0 : data);
        (res[name] = res[name] || {})[an] = val;
      }
    }
    off += size;
  }
  return res;
}

function inspectApk(file) {
  const stat = fs.statSync(file);
  const fd = fs.openSync(file, 'r');
  try {
    const entries = zipEntries(fd, stat.size);
    const mf = entries.find((e) => e.name === 'AndroidManifest.xml');
    if (!mf) throw new Error('AndroidManifest.xml not found - is this an APK? (.aab is not installable directly)');
    const m = parseManifest(zipRead(fd, mf));
    const abis = [...new Set(entries.map((e) => /^lib\/([^/]+)\//.exec(e.name)).filter(Boolean).map((x) => x[1]))];
    const names = entries.map((e) => e.name);
    const il2cpp = names.some((n) => n.endsWith('libil2cpp.so')) || names.some((n) => n.includes('il2cpp_data'));
    const mono = names.some((n) => n.includes('libmono'));
    const unity = names.some((n) => n.endsWith('libunity.so'));
    return {
      file,
      name: path.basename(file),
      size: stat.size,
      package: m.manifest && m.manifest.package,
      versionName: m.manifest && m.manifest.versionName,
      versionCode: m.manifest && m.manifest.versionCode,
      minSdk: m['uses-sdk'] && m['uses-sdk'].minSdkVersion,
      targetSdk: m['uses-sdk'] && m['uses-sdk'].targetSdkVersion,
      debuggable: !!(m.application && m.application.debuggable),
      abis,
      unity,
      backend: il2cpp ? 'IL2CPP' : mono ? 'Mono' : unity ? 'Unknown' : null,
    };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { inspectApk };
