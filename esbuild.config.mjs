// Bundles src/main.ts into main.js for the Obsidian plugin.
//
// Usage:   node esbuild.config.mjs [--watch] [--dev]
// Example: node esbuild.config.mjs            (minified, what a release ships; `pnpm build`)
//          node esbuild.config.mjs --dev       (readable + inline sourcemap; `pnpm build:dev`)
//          node esbuild.config.mjs --watch     (rebuild on change, implies --dev; `pnpm dev`)
//
// The default is minified with no sourcemap, so what is built here is what users get. --dev
// trades that for a readable bundle and an inline sourcemap, which is what the WebView
// debugging in scripts/deploy-android.sh reads; it also makes the bundle roughly eight times
// larger, three quarters of it sourcemap.

import esbuild from "esbuild";
import process from "process";

const watch = process.argv.includes("--watch");
// Watching is only ever development, so it carries the sourcemap without being asked.
const dev = process.argv.includes("--dev") || watch;

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: dev ? "inline" : false,
  minify: !dev,
  outfile: "main.js",
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
