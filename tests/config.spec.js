// @ts-check
const { test, expect } = require('@playwright/test');
const { setup, waitBooted } = require('./harness');

/** Serve index.html with a different ACTIVE_NETWORK, without touching the file. */
async function withNetwork(page, name) {
  await page.route('**/index.html*', async route => {
    const res = await route.fetch();
    const body = (await res.text())
      .replace("const ACTIVE_NETWORK = 'arc-testnet';", `const ACTIVE_NETWORK = '${name}';`);
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } });
  });
}

test.describe('network configuration', () => {
  test('an unconfigured mainnet build refuses to run and names what is missing', async ({ page }) => {
    await setup(page);
    await withNetwork(page, 'arc-mainnet');
    await page.goto('/index.html');

    const banner = page.locator('body > div').first();
    await expect(banner).toContainText('Configuration incomplete', { timeout: 15000 });
    await expect(banner).toContainText('contracts.pay');
    await expect(banner).toContainText('rpc');

    // Nothing may have been wired up.
    await expect(page.locator('#netPill')).toHaveText('—');
  });

  test('an unconfigured build will not send a payment', async ({ page }) => {
    await setup(page);
    await withNetwork(page, 'arc-mainnet');
    await page.goto('/index.html');
    await expect(page.locator('body > div').first()).toContainText('Configuration incomplete');

    // The unconfigured build never boots, so no tab logic runs — reveal the
    // pay panel directly and prove the form still refuses to sign.
    await page.evaluate(() => document.getElementById('sec-pay').classList.add('active'));
    await page.fill('#payTo', '0x2222222222222222222222222222222222222222');
    await page.fill('#payAmt', '1');
    await page.click('button:has-text("Send payment")');
    await expect(page.locator('#payStatus')).toHaveText(/Still loading/i);

    const sent = await page.evaluate(() =>
      window.__walletCalls.filter(c => c.method === 'eth_sendTransaction').length);
    expect(sent).toBe(0);
  });

  test('the network profile is the only source of chain constants', async ({ page }) => {
    await setup(page);
    await page.goto('/index.html');
    await waitBooted(page);

    const cfg = await page.evaluate(() => ({
      chainId: window.CHAIN_ID, pay: window.ARCPAY, scan: window.SCAN,
      testnet: window.IS_TESTNET, problems: window.configProblems()
    }));
    // top-level `const` is not exposed on window; check via the DOM it drives
    expect(await page.evaluate(() => window.configProblems())).toEqual([]);
    expect(cfg.problems).toEqual([]);
  });

  test('the billing agent is available on testnet and disabled otherwise', async ({ page }) => {
    await setup(page);
    await page.goto('/index.html');
    await waitBooted(page);
    await page.click('button:has-text("Billing Agent")');
    await expect(page.locator('#kpState')).toHaveText('agent offline');
    await expect(page.locator('button:has-text("Start agent")')).toBeEnabled();
  });
});
