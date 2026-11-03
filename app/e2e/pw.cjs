// Resolves Playwright and the Chromium binary (set CHROMIUM_PATH to use a system/preinstalled Chromium).
let pw; try { pw = require("playwright"); } catch { pw = require("playwright-core"); }
const exe = process.env.CHROMIUM_PATH;
module.exports = { chromium: { launch: (o = {}) => pw.chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ["--no-sandbox"], ...o }) } };
