import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.e2e.test.ts', 'node_modules'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/cli/**',
        'src/mcp/server.ts',
        'src/shared/protocol/messages.ts',
        'src/shared/crypto/index.ts',
        'src/shared/protocol/index.ts',
      ],
      reporter: ['text', 'text-summary', 'lcov', 'json-summary'],
      thresholds: {
        statements: 50,
        branches: 40,
        functions: 50,
        lines: 50,
      },
    },
  },
});
