// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/* The app is a single static page, so the "server" is just a file server over
   the repo root — vendor/ethers must be reachable at a real origin for the
   loader fallback and for pay-link URL generation to behave like production. */
module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'list' : [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8080',
    trace: 'on-first-retry'
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Set PLAYWRIGHT_CHROMIUM_EXECUTABLE when the machine already has a
        // Chromium that Playwright did not download itself.
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
          : {}
      }
    }
  ],
  webServer: {
    command: 'node tests/static-server.js',
    url: 'http://127.0.0.1:8080/index.html',
    reuseExistingServer: !process.env.CI,
    timeout: 30000
  }
});
