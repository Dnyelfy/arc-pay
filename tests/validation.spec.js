// @ts-check
const { test, expect } = require('@playwright/test');
const { setup, waitBooted, goTab, ACCOUNT } = require('./harness');

test.beforeEach(async ({ page }) => {
  await setup(page);
  await page.goto('/index.html');
  await waitBooted(page);
});

test.describe('amount parsing', () => {
  test('accepts a comma decimal instead of silently truncating it', async ({ page }) => {
    // "10,50" used to parse as 10 and send the wrong amount without warning.
    expect(await page.evaluate(() => window.parseAmount('10,50'))).toBe('10.50');
    expect(await page.evaluate(() => window.parseAmount('0,004'))).toBe('0.004');
  });

  test('accepts ordinary decimals and trims whitespace', async ({ page }) => {
    expect(await page.evaluate(() => window.parseAmount('1.5'))).toBe('1.5');
    expect(await page.evaluate(() => window.parseAmount('  2  '))).toBe('2');
    expect(await page.evaluate(() => window.parseAmount('.75'))).toBe('.75');
  });

  test('rejects everything that is not a positive number', async ({ page }) => {
    const rejected = await page.evaluate(() =>
      ['', '   ', '0', '0.0', '-1', '-0.5', 'abc', '1.2.3', '1e9', 'NaN', 'Infinity', '1,2,3', null, undefined]
        .map(v => window.parseAmount(v)));
    expect(rejected.every(v => v === null)).toBe(true);
  });
});

test.describe('form validation', () => {
  test('payment refuses an invalid recipient', async ({ page }) => {
    await goTab(page, 'pay');
    await page.fill('#payTo', 'not-an-address');
    await page.fill('#payAmt', '1');
    await page.click('button:has-text("Send payment")');
    await expect(page.locator('#payStatus')).toHaveText(/valid recipient address/i);
  });

  test('payment refuses a zero or negative amount', async ({ page }) => {
    await goTab(page, 'pay');
    await page.fill('#payTo', '0x2222222222222222222222222222222222222222');
    await page.fill('#payAmt', '-5');
    await page.click('button:has-text("Send payment")');
    await expect(page.locator('#payStatus')).toHaveText(/above zero/i);
  });

  test('split refuses a line that is not an address, naming the line', async ({ page }) => {
    await goTab(page, 'split');
    await page.fill('#splitTo', '0x2222222222222222222222222222222222222222\nrubbish');
    await page.fill('#splitAmt', '10');
    await page.click('button:has-text("Split & send")');
    await expect(page.locator('#splitStatus')).toHaveText(/Line 2 is not a valid address/i);
  });

  test('split preview handles a comma decimal', async ({ page }) => {
    await goTab(page, 'split');
    await page.fill('#splitTo', '0x2222222222222222222222222222222222222222\n0x3333333333333333333333333333333333333333');
    await page.fill('#splitAmt', '10,50');
    await expect(page.locator('#splitPreview')).toHaveText(/2 recipient\(s\).*5\.2500 USDC each/);
  });

  test('split refuses more than 20 recipients', async ({ page }) => {
    await goTab(page, 'split');
    const many = Array.from({ length: 21 }, (_, i) =>
      '0x' + String(i + 1).padStart(2, '0').repeat(20)).join('\n');
    await page.fill('#splitTo', many);
    await page.fill('#splitAmt', '10');
    await page.click('button:has-text("Split & send")');
    await expect(page.locator('#splitStatus')).toHaveText(/Between 1 and 20 recipients/i);
  });

  test('subscription refuses a negative amount', async ({ page }) => {
    // parseFloat used to let -5 through: truthy and not NaN.
    await goTab(page, 'subs');
    await page.fill('#subTo', '0x2222222222222222222222222222222222222222');
    await page.fill('#subAmt', '-5');
    await page.click('button:has-text("Subscribe")');
    await expect(page.locator('#subStatus')).toHaveText(/above zero/i);
  });

  /* Funding is owner-only: deposit() is open to anyone but withdraw() is
     onlyOwner, so a stranger's deposit is an irreversible gift. The control is
     withheld rather than shown behind a warning. */
  test('the fund controls stay closed while the treasury owner is unknown', async ({ page }) => {
    await goTab(page, 'treasury');
    await expect(page.locator('#tFundRow')).toBeHidden();
    await expect(page.locator('#tFundLocked')).toContainText(/owner-only|Refresh health/i);
  });

  test('funding from a wallet that is not the owner is refused, not just warned', async ({ page }) => {
    await goTab(page, 'treasury');
    // Reach past the hidden control the way a console or a stale page could:
    // the guard has to live in the function, not only in the markup.
    await page.evaluate(() => {
      document.getElementById('tDepAmt').value = '50';
      return window.treasuryDeposit('usdc');
    });
    await expect(page.locator('#tStatus')).toHaveText(/owner-only|Refresh health/i);
  });
});

test.describe('treasury funding, as the owner', () => {
  const OWNER_WORD = '0x' + '00'.repeat(12) + ACCOUNT.slice(2);
  // getStatus() → (usdcBal, eurcBal, targetBps, driftBps, maxConfBps, bonusBps, paused)
  const STATUS = '0x' + [
    (5000e6).toString(16).padStart(64, '0'),   // 5000 USDC
    (5000e6).toString(16).padStart(64, '0'),   // 5000 EURC
    (6000).toString(16).padStart(64, '0'),
    (200).toString(16).padStart(64, '0'),
    (100).toString(16).padStart(64, '0'),
    (25).toString(16).padStart(64, '0'),
    ''.padStart(64, '0')                       // not paused
  ].join('');

  test.beforeEach(async ({ page }) => {
    await setup(page, { rpc: { eth_call: params => {
      const data = (params && params[0] && params[0].data) || '';
      if (data.startsWith('0x8da5cb5b')) return OWNER_WORD;   // owner()
      if (data.startsWith('0x4e69d560')) return STATUS;       // getStatus()
      return '0x';
    } } });
    await page.goto('/index.html');
    await waitBooted(page);
  });

  test('the owner is offered the fund controls, and the amount is still validated', async ({ page }) => {
    await goTab(page, 'treasury');
    await page.click('button:has-text("Connect")');
    await page.click('button:has-text("Refresh health")');
    await expect(page.locator('#tFundRow')).toBeVisible();

    await page.fill('#tDepAmt', 'abc');
    await page.click('button:has-text("Fund USDC")');
    await expect(page.locator('#tStatus')).toHaveText(/above zero/i);
  });
});
