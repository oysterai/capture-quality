import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The core is pure, but the web adapter and the ported normalize spec need
    // document/canvas, and both consuming apps already run their suites on jsdom.
    environment: 'jsdom',
    include: ['test/**/*.spec.ts'],
  },
})
