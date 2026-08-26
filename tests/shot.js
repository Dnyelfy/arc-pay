/* Screenshot helper — not part of the test suite; run with:
   PLAYWRIGHT_CHROMIUM_EXECUTABLE=... node tests/shot.js  */
const { chromium } = require('@playwright/test');
const { stubEthersCdn, stubRpc, stubExternal, installWallet } = require('./harness');
const path = require('path');

(async () => {
  const out = process.argv[2] || '/tmp/shots';
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await stubEthersCdn(page); await stubRpc(page); await stubExternal(page);
  await installWallet(page);
  await page.goto('http://127.0.0.1:8080/index.html');
  await page.waitForFunction(() => document.getElementById('netPill').textContent !== '—');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(out, 'hero.png') });
  await page.screenshot({ path: path.join(out, 'full.png'), fullPage: true });
  for (const t of ['agent', 'pay', 'treasury']) {
    await page.click('#tab-' + t);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(out, t + '.png'), fullPage: true });
  }
  await browser.close();
  console.log('shots written to', out);
})();
