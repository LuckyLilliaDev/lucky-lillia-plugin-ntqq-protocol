import { defineConfig } from 'vitest/config'
import path from 'node:path'
export default defineConfig({
  resolve: { alias: { qrcode: path.resolve(import.meta.dirname, 'node_modules/qrcode/lib/server.js') } },
  test: { include: ['test/**/*.test.ts'], environment: 'node', setupFiles: ['test/setup.ts'], mockReset: true },
})
