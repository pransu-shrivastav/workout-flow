import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
    viewport: { width: 390, height: 844 }, // iPhone 14 Pro
    // Each test gets a fresh browser context (isolated IndexedDB)
    storageState: undefined,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
  // Start a local server before running e2e tests
  webServer: {
    command: 'npx serve . -p 3000 --no-clipboard',
    port: 3000,
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});