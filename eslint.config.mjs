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
  {
    // `ui/sentence-case` has no notion of proper nouns or of strings that aren't
    // prose, and the preset forbids silencing it inline (`no-restricted-disable`),
    // so the exemption has to live here. Kept to the two files that need it rather
    // than switched off globally — it does catch real casing slips in new UI text.
    //
    // - pm-compass-view.ts: "PM Compass dashboard", the plugin's own name.
    // - settings-tab.ts: the `daily` placeholder, which is the literal default tag
    //   value — "Daily" would imply the tag is `#Daily`.
    files: ["src/ui/pm-compass-view.ts", "src/ui/settings-tab.ts"],
    rules: { "obsidianmd/ui/sentence-case": "off" },
  },
];
