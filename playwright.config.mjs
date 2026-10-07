import { defineConfig } from '@playwright/test'

const databaseUrl = process.env.E2E_DATABASE_URL ?? process.env.TEST_DATABASE_URL
if (!databaseUrl) {
  throw new Error('E2E_DATABASE_URL or TEST_DATABASE_URL must point to a dedicated database ending in _test')
}
const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1))
if (!databaseName.endsWith('_test')) {
  throw new Error('Refusing browser acceptance outside a dedicated database ending in _test')
}

const apiOrigin = 'http://127.0.0.1:4000'
const webOrigin = 'http://127.0.0.1:4173'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  use: {
    baseURL: webOrigin,
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'node apps/api/dist/server.js',
      url: `${apiOrigin}/health`,
      timeout: 30_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        REDIS_URL: '',
        PORT: '4000',
        HOST: '127.0.0.1',
        AUTO_MIGRATE: 'true',
        ENABLE_DEV_BOOTSTRAP: 'true',
        ENABLE_LOCAL_RUNTIME_CONTROL: 'false',
        AUTH_MODE: 'local',
        AUTH_DEFAULT_WORKSPACE_ID: 'demo_workspace',
        LOCAL_AUTH_USER_ID: 'demo_user',
        AUTH_ALLOWED_ORIGINS: webOrigin,
        MODEL_PROVIDER: 'test',
        MODEL_NAME: 'e2e-no-model',
      },
    },
    {
      command: 'npm run web:start',
      url: webOrigin,
      timeout: 30_000,
      reuseExistingServer: false,
    },
  ],
})
