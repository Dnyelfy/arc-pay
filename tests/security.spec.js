// @ts-check
const { test, expect } = require('@playwright/test');
const { setup, waitBooted } = require('./harness');

const PAYLOAD = '<img src=x onerror="window.__pwned=1">';

test.beforeEach(async ({ page }) => {
  await setup(page);
  await page.goto('/index.html');
  await waitBooted(page);
});

test.describe('untrusted strings from the chain', () => {
  test('the agent terminal renders a hostile subscription label as text', async ({ page }) => {
    // Subscription labels are written by whoever opens the subscription. The
    // terminal used to concatenate them into innerHTML, inside the very page
    // that holds the agent's private key in localStorage.
    await page.evaluate(p => window.kpLog(`Subscription #1 ("${p}") is due`), PAYLOAD);

    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
    expect(await page.evaluate(() => document.querySelectorAll('#kpTerm img').length)).toBe(0);
    await expect(page.locator('#kpTerm')).toContainText(PAYLOAD);   // shown, not executed
  });

  test('the agent terminal is bounded so a hostile chain cannot grow it forever', async ({ page }) => {
    await page.evaluate(() => { for (let i = 0; i < 400; i++) window.kpLog('line ' + i); });
    const lines = await page.evaluate(() => document.getElementById('kpTerm').childElementCount);
    expect(lines).toBeLessThanOrEqual(300);
  });

  test('escHtml neutralizes markup and tolerates non-strings', async ({ page }) => {
    expect(await page.evaluate(() => window.escHtml('<script>alert(1)</script>')))
      .toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(await page.evaluate(() => window.escHtml(`" onmouseover='x'`)))
      .toBe('&quot; onmouseover=&#39;x&#39;');
    expect(await page.evaluate(() => window.escHtml(null))).toBe('');
    expect(await page.evaluate(() => window.escHtml(42))).toBe('42');
  });

  test('a hostile note on an incoming pay-link is escaped', async ({ page }) => {
    await page.goto('/index.html?to=0x2222222222222222222222222222222222222222&amt=1&note=' +
                    encodeURIComponent(PAYLOAD));
    await waitBooted(page);
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
    expect(await page.evaluate(() => document.querySelectorAll('#incomingReceipt img').length)).toBe(0);
  });

  test('the ethers bundle is loaded with integrity and CORS pinning', async ({ page }) => {
    const attrs = await page.evaluate(() => {
      const s = [...document.querySelectorAll('script')].find(x => (x.src || '').includes('cdnjs'));
      return s ? { integrity: s.integrity, crossOrigin: s.crossOrigin } : null;
    });
    expect(attrs).not.toBeNull();
    expect(attrs.integrity).toMatch(/^sha384-/);
    expect(attrs.crossOrigin).toBe('anonymous');
  });
});
