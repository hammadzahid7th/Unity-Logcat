const RE = /^(?:(\d{4})-)?(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+(.*?)\s*: (.*)$/;

function parseLine(raw) {
  const m = RE.exec(raw);
  if (!m) return null;
  return {
    t: Date.UTC(+(m[1] || new Date().getFullYear()), +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]),
    pid: +m[8], tid: +m[9], lvl: m[10], tag: m[11], msg: m[12],
  };
}
module.exports = { parseLine };
