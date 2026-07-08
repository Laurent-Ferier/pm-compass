import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  {
    ignores: [
      "**/*.test.ts",
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
