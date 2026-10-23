// Turns raw adb output into a plain-language "what to do" line. Returns null when nothing matches.
const RULES = {
  connect: [
    [/no route to host|timed out|unreachable/i, 'The Mac cannot reach the phone. Same Wi-Fi? On macOS also check System Settings > Privacy & Security > Local Network. Press "Can\'t see my phone?".'],
    [/unauthorized|protocol fault/i, 'Pair the phone first (QR code or pairing code), then connect.'],
    [/failed to connect|cannot connect|unable to connect|refused|failed to authenticate/i, 'Use the IP:port from the MAIN Wireless debugging screen, not the pairing popup. The port changes every time Wireless debugging is switched on.'],
  ],
  pair: [
    [/failed to pair|wrong password|pairing code|incorrect|error/i, 'Pairing failed. The code and IP:port expire quickly: keep the phone\'s pairing popup open and type the numbers it shows right now, or use the QR code.'],
    [/timed out|unreachable|refused/i, 'The Mac cannot reach the phone. Same Wi-Fi? Check Local Network permission.'],
  ],
  install: [
    [/INSTALL_FAILED_USER_RESTRICTED|INSTALL_FAILED_ABORTED.*user|user restricted/i, 'The phone blocked the install. Developer options: turn ON "Install via USB" (Xiaomi/Redmi also "USB debugging (Security settings)"; Oppo/Vivo "Allow install via USB"), then tap Install/Allow on the phone when asked.'],
    [/INSUFFICIENT_STORAGE/i, 'The phone is out of storage. Free some space and try again.'],
    [/OLDER_SDK/i, 'This phone\'s Android version is too old for this build.'],
    [/NO_MATCHING_ABIS/i, 'This build has no code for this phone\'s CPU (needs arm64-v8a or armeabi-v7a). Ask the developer for an ARM build.'],
    [/NO_CERTIFICATES|PARSE_FAILED|not a valid|MANIFEST_MALFORMED/i, 'The APK is unsigned or damaged. Ask the developer to re-export it.'],
    [/VERIFICATION_FAILURE|play protect|blocked by/i, 'Play Protect or the phone blocked it. Tap "Install anyway" on the phone, or turn off Play Protect scanning.'],
    [/UPDATE_INCOMPATIBLE|signatures do not match|signature/i, 'Signature differs from the installed build. Tick "Clean install" (removes the old build first).'],
    [/NO_DEVICES|no devices|device offline|device not found|closed/i, 'The phone disconnected. Reconnect it and try again.'],
    [/unauthorized/i, 'Tap "Allow USB debugging" on the phone.'],
  ],
};

function friendly(kind, text) {
  for (const [re, msg] of RULES[kind] || []) if (re.test(text || '')) return msg;
  return null;
}
module.exports = { friendly };
