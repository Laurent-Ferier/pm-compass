// Bundles src/main.ts into main.js for the Obsidian plugin.
//
// Usage:   node esbuild.config.mjs [--watch]
// Example: node esbuild.config.mjs            (one-off build, invoked by `pnpm build`)
//          node esbuild.config.mjs --watch     (rebuild on change, invoked by `pnpm dev`)

import esbuild from "esbuild";
import process from "process";

const watch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: "inline",
  outfile: "main.js",
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
