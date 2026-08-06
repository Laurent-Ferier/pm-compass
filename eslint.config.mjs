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
    },
  },
  {
    // The store folder is the only place a task note is read or written. Everything above
    // it — the views, the plugin — asks `TaskStore`, which is what lets the store hold
    // what it has read and re-read only what changed. A test may still reach for a note
    // class to stand one up.
    files: ["src/ui/**/*.ts", "src/main.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: [
            "**/store/base-note",
            "**/store/project-note",
            "**/store/project-file",
            "**/store/project-task-file",
            "**/store/day-markdown-file",
            "**/store/day-store",
          ],
          message: "Read and write tasks through `TaskStore` (model/store/task-store).",
        }],
      }],
    },
  },
  {
    // The IO layer is the bottom of the model: the notes it reads and writes know nothing
    // of what the plugin makes of them. `i-model.ts` is the one exception — what a note
    // wakes when a file has changed under it.
    files: ["src/model/io/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["../*", "../../*", "!../i-model"],
          message: "The IO layer reads notes; what they mean belongs above it.",
        }],
      }],
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
