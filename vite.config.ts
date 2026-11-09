// Vite builds `dist/` (library mode, SSR flavoured so Node built-ins and
// dependencies stay external) and, through Vitest, runs the tests. One config
// means one alias table. `npm run coverage` enforces the per-file 90% gate on
// all four dimensions (#4854); code that genuinely cannot run in the test
// process carries a `v8 ignore` with its reason instead of a lower threshold.
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      // Keep in sync with `paths` in tsconfig.json (that one is for the editor
      // and `tsc`; this one is what actually rewrites imports).
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    ssr: true,
    target: "node24",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        index: "src/index.ts",
        version: "src/version.ts",
      },
      output: {
        format: "es",
        // One file per module (dist/index.js, dist/version.js) so the
        // server finds package.json relative to dist/ as before.
        preserveModules: true,
        preserveModulesRoot: "src",
        entryFileNames: "[name].js",
      },
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["**/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["**/*.ts"],
      exclude: ["**/__tests__/**", "**/dist/**", "vite.config.ts"],
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
