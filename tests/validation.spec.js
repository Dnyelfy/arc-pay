// @ts-check
const { test, expect } = require('@playwright/test');
const { setup, waitBooted } = require('./harness');

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
    await page.fill('#payTo', 'not-an-address');
    await page.fill('#payAmt', '1');
    await page.click('button:has-text("Send payment")');
    await expect(page.locator('#payStatus')).toHaveText(/valid recipient address/i);
  });

  test('payment refuses a zero or negative amount', async ({ page }) => {
    await page.fill('#payTo', '0x2222222222222222222222222222222222222222');
    await page.fill('#payAmt', '-5');
    await page.click('button:has-text("Send payment")');
    await expect(page.locator('#payStatus')).toHaveText(/above zero/i);
  });

  test('split refuses a line that is not an address, naming the line', async ({ page }) => {
    await page.click('button:has-text("Split")');
    await page.fill('#splitTo', '0x2222222222222222222222222222222222222222\nrubbish');
    await page.fill('#splitAmt', '10');
    await page.click('button:has-text("Split & send")');
    await expect(page.locator('#splitStatus')).toHaveText(/Line 2 is not a valid address/i);
  });

  test('split preview handles a comma decimal', async ({ page }) => {
    await page.click('button:has-text("Split")');
    await page.fill('#splitTo', '0x2222222222222222222222222222222222222222\n0x3333333333333333333333333333333333333333');
    await page.fill('#splitAmt', '10,50');
    await expect(page.locator('#splitPreview')).toHaveText(/2 recipient\(s\).*5\.2500 USDC each/);
  });

  test('split refuses more than 20 recipients', async ({ page }) => {
    await page.click('button:has-text("Split")');
    const many = Array.from({ length: 21 }, (_, i) =>
      '0x' + String(i + 1).padStart(2, '0').repeat(20)).join('\n');
    await page.fill('#splitTo', many);
    await page.fill('#splitAmt', '10');
    await page.click('button:has-text("Split & send")');
    await expect(page.locator('#splitStatus')).toHaveText(/Between 1 and 20 recipients/i);
  });

  test('subscription refuses a negative amount', async ({ page }) => {
    // parseFloat used to let -5 through: truthy and not NaN.
    await page.click('button:has-text("Subscriptions")');
    await page.fill('#subTo', '0x2222222222222222222222222222222222222222');
    await page.fill('#subAmt', '-5');
    await page.click('button:has-text("Subscribe")');
    await expect(page.locator('#subStatus')).toHaveText(/above zero/i);
  });

  test('treasury deposit refuses a non-numeric amount', async ({ page }) => {
    await page.click('button:has-text("Treasury")');
    await page.fill('#tDepAmt', 'abc');
    await page.click('button:has-text("Fund USDC")');
    await expect(page.locator('#tStatus')).toHaveText(/above zero/i);
  });
});
