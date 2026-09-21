const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
let pw;
try { pw = require('playwright'); } catch {
  pw = require(path.join(process.env.USERPROFILE || process.env.HOME, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
}
function chromiumPath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const dir = path.join(process.env.USERPROFILE || process.env.HOME, '.cache/puppeteer/chrome');
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).reverse()) {
      const p = path.join(dir, name, 'chrome-win64/chrome.exe');
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}
async function launch() { return pw.chromium.launch({ headless: true, executablePath: chromiumPath() }); }
const url = pathToFileURL(path.resolve(__dirname, '../msf-prototype.html')).href;
module.exports = { launch, url, pathToFileURL };
