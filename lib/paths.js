const path = require('path');
const ROOT = path.join(__dirname, '..');
// When packaged as a .app, user data (sessions, uploads, downloaded tools) lives outside the app bundle.
const DATA = process.env.DATA_DIR || ROOT;
module.exports = { ROOT, DATA, TOOLS: process.env.TOOLS_DIR || path.join(DATA, 'tools') };
