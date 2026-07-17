import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  {
    ignores: [
      "**/*.test.ts",
      // Test-only helpers: linted as production code they'd fail rules that
      // don't apply to mocks, and they never ship in the bundle.
      "**/__testing__/**",
      "vitest.config.ts",
      "esbuild.config.mjs",
      "scripts/**",
      "coverage/**",
      "**/coverage/**",
      "dist/**",
      "release/**",
      "main.js",
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
];
