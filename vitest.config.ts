import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("test"),
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      // Only covers src/** exercised by Vitest (component/hook/utility
      // tests). The 24 direct Node assertion scripts under scripts/**
      // (run via scripts/run-direct-tests.ts) are not instrumented here —
      // see README's validation section for that scope split.
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "./coverage",
      // Baseline measured 2026-08-31: ~46.6% stmts / 39.9% branch / 43.7%
      // funcs / 51.1% lines. Thresholds sit a few points below that so
      // normal coverage noise doesn't break CI, while still catching a
      // real regression. Raise them as coverage improves.
      thresholds: {
        statements: 40,
        branches: 35,
        functions: 35,
        lines: 45,
      },
    },
  },
});
