import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/**/*.test.ts", "packages/*/src/__mocks__/**"],
      reporter: ["text", "html"],
      reportsDirectory: "coverage",
    },
  },
  resolve: {
    alias: {
      // obsidian has "main": "" — it's types-only and can't be resolved by Vite.
      // Point it to a stub; vi.mock("obsidian", factory) overrides this in tests.
      obsidian: resolve(
        __dirname,
        "packages/plugin/src/__mocks__/obsidian.ts",
      ),
    },
  },
});
