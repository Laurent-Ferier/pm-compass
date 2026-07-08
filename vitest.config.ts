import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/__mocks__/**"],
      reporter: ["text", "html"],
      reportsDirectory: "coverage",
    },
  },
  resolve: {
    alias: {
      // obsidian has "main": "" — it's types-only and can't be resolved by Vite.
      // Point it to a stub; vi.mock("obsidian", factory) overrides this in tests.
      obsidian: resolve(__dirname, "src/__mocks__/obsidian.ts"),
    },
  },
});
