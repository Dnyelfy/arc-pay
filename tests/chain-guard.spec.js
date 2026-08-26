// @ts-check
const { test, expect } = require('@playwright/test');
const { setup, waitBooted, goTab } = require('./harness');

const RECIPIENT = '0x2222222222222222222222222222222222222222';
const sends = page => page.evaluate(() =>
  window.__walletCalls.filter(c => c.method === 'eth_sendTransaction').length);

test.describe('wrong-network guard', () => {
  test('a payment on the right chain reaches the wallet', async ({ page }) => {
    await setup(page);
    await page.goto('/index.html');
    await waitBooted(page);

    await page.click('#connBtn');
    await expect(page.locator('#connBtn')).toContainText('✕');

    await goTab(page, 'pay');
    await page.fill('#payTo', RECIPIENT);
    await page.fill('#payAmt', '1.5');
    await page.click('button:has-text("Send payment")');

    await expect(page.locator('#payStatus')).toHaveText(/Paid 1\.5 USDC/i, { timeout: 15000 });
    expect(await sends(page)).toBe(1);
  });

  test('a chain switched after connecting blocks the send', async ({ page }) => {
    // This is the case the guard exists for: connect on Arc, switch the wallet
    // to another chain, then hit Send. Without the guard the transaction goes
    // out on whatever chain the wallet happens to be on.
    await setup(page);
    await page.goto('/index.html');
    await waitBooted(page);

    await page.click('#connBtn');
    await expect(page.locator('#connBtn')).toContainText('✕');
    const before = await sends(page);

    await page.evaluate(() => {
      window.__switchShouldFail = true;
      const orig = window.ethereum.request.bind(window.ethereum);
      window.ethereum.request = async req => {
        if (req.method === 'wallet_switchEthereumChain') { const e = new Error('User rejected'); e.code = 4001; throw e; }
        if (req.method === 'eth_chainId') return '0x1';        // wallet is now on Ethereum
        return orig(req);
      };
    });

    await goTab(page, 'pay');
    await page.fill('#payTo', RECIPIENT);
    await page.fill('#payAmt', '1');
    await page.click('button:has-text("Send payment")');

    await expect(page.locator('#payStatus')).toHaveText(/rejected|wrong network/i, { timeout: 15000 });
    expect(await sends(page), 'no transaction may be issued on the wrong chain').toBe(before);
  });

  test('a wallet that does not know Arc is asked to add it', async ({ page }) => {
    await setup(page, { chainId: '0x1', switchBehavior: 'unknown-chain' });
    await page.goto('/index.html');
    await waitBooted(page);

    await page.click('#connBtn');
    await expect(page.locator('#connBtn')).toContainText('✕', { timeout: 15000 });

    const added = await page.evaluate(() =>
      window.__walletCalls.find(c => c.method === 'wallet_addEthereumChain'));
    expect(added).toBeTruthy();
    expect(added.params[0].chainId).toBe('0x4cef52');
    expect(added.params[0].nativeCurrency.symbol).toBe('USDC');
  });

  test('disconnect clears wallet-derived state', async ({ page }) => {
    await setup(page);
    await page.goto('/index.html');
    await waitBooted(page);

    await page.click('#connBtn');
    await expect(page.locator('#balPill')).toBeVisible();

    await page.click('#connBtn');   // now bound to disconnect
    await expect(page.locator('#connBtn')).toHaveText('Connect wallet');
    await expect(page.locator('#balPill')).toBeHidden();
    await expect(page.locator('#mySubsList')).toContainText('Connect your wallet and refresh');
  });
});
