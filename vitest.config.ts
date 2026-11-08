// Vitest config for the memory server. `npm run coverage` enforces the
// per-file 90% gate on all four dimensions (#4854); code that genuinely
// cannot run in the test process carries a `v8 ignore` with its reason
// instead of a lower threshold.
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["**/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["**/*.ts"],
      exclude: ["**/__tests__/**", "**/dist/**"],
      thresholds: {
        perFile: true,
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
      },
    },
  },
});
