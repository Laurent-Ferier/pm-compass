import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  {
    ignores: [
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
    // Tests get the same lint as the code they cover, minus the two families that only
    // ever fire on the scaffolding. Everything that catches a real defect — floating
    // promises, deprecations, enum comparisons — stays on.
    files: ["**/*.test.ts"],
    // Tests run in Node, not in Obsidian's renderer.
    languageOptions: { globals: { __dirname: "readonly" } },
    rules: {
      // `createEl` is Obsidian's helper on its own elements; the DOM a test builds by
      // hand is plain jsdom, which has only `createElement`.
      "obsidianmd/prefer-create-el": "off",
      // The mocks are deliberately untyped, and these read that as production risk.
      // The rest of the type-aware rules still apply.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  {
    // The one test that reads the repo off disk — it checks every source file for an icon
    // name spelled out at a call site, which no Obsidian API can answer.
    files: ["src/ui/icons.test.ts"],
    rules: { "obsidianmd/no-nodejs-modules": "off" },
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
