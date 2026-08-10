#!/usr/bin/env node
//
// Renders every mermaid source under docs/technical/diagrams/ and writes the class-map page
// around the results.
//
//   pnpm docs:diagrams           renders, and writes the page and the fences
//   pnpm docs:diagrams --check   asserts every source still draws and is embedded (CI)
//
// The diagrams are the one place the class structure is drawn: the prose docs embed the same
// sources as ```mermaid fences, which GitHub renders itself, and this pass is what makes
// them readable off a file:// URL as well. Both the SVGs and the page are committed, so
// reading the docs needs no mermaid — only editing a diagram does.
//
// `--check` renders to a scratch folder and compares the *sources* against what the docs
// embed, rather than the committed SVGs byte for byte: mermaid measures text to lay a diagram
// out, so the same source drawn on a machine with different fonts is a different file, and a
// byte comparison would fail on the runner's font list rather than on anything anyone wrote.
//
// Each source is rendered twice, light and dark: mermaid bakes the text colour into the SVG,
// so one rendering is unreadable in one of the two themes.

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(root, "docs", "technical", "diagrams");
const check = process.argv.includes("--check");
const outDir = check ? join(sourceDir, "out.check") : join(sourceDir, "out");
const page = join(root, "docs", "technical", "class-map.html");
/** The docs that embed the sources. Each diagram belongs to exactly one of them. */
const proseDocs = ["data-model.md", "task-listings.md"].map((file) => join(root, "docs", "technical", file));
const failures = [];

/** The page's order, and what each diagram is there to answer. A source with no entry here
 *  is still rendered — it just falls to the end, uncaptioned. */
const CAPTIONS = {
  overview: "Which object builds which, from the plugin down to a task. Dotted lines are what a cache hands out rather than what it holds.",
  "vault-change": "One note edited on disk, and what it costs before a view redraws.",
  "plugin-change": "The same trip in reverse: a setter, the write it owes the note, and the redraw the user is waiting on.",
  models: "What the plugin makes of a note. Every model is live: it holds the reading and is woken when the file moves.",
  io: "The bottom of the IO layer. An IO reads and writes one note and holds none of what it says.",
  caches: "The rest of the IO layer: where the readings are held, one entry per path, and who watches the vault for them.",
  service: "The layer above the caches — which settings, when, and what to invalidate once a write has landed.",
  "listing-copies": "Where a task's status and title are written down: once in the task's own frontmatter, and twice more in the note that lists it. What a model holds of each.",
  "listing-box-ticked": "A `## Tasks` box flipped in the editor, and the task it closes — or, for a listing nobody has checked yet, the status that rewrites it.",
  "listing-task-changed": "The other direction: a task note that moved, the line that lists it, and the one case that adds a line rather than mirroring onto it.",
  "ui-dashboard": "The dashboard leaf: the three tabs it keeps alive, the list every row goes in, and the modals they open.",
  "ui-graph": "The task graph leaf, and the nodes and edges it draws with instead of a graph library.",
  "ui-settings": "The settings tab, and the sections and rows it is built from.",
};

const ORDER = Object.keys(CAPTIONS);

function titleOf(source) {
  const match = /^---\s*\ntitle:\s*(.+?)\s*\n/.exec(source);
  return match ? match[1] : null;
}

function render(name, theme) {
  const out = join(outDir, `${name}-${theme}.svg`);
  execFileSync(
    "pnpm",
    ["exec", "mmdc",
      "--input", join(sourceDir, `${name}.mmd`),
      "--output", out,
      "--theme", theme === "dark" ? "dark" : "default",
      "--backgroundColor", "transparent",
      "--puppeteerConfigFile", join(sourceDir, "puppeteer.json"),
      // Mermaid draws every box and line through rough.js, seeded at random unless it is
      // told otherwise — two renders of one source differ in every coordinate without this,
      // and the CI check would fail on a diff nobody made.
      "--configFile", join(sourceDir, "mermaid.json"),
      "--quiet"],
    { cwd: root, stdio: ["ignore", "ignore", "inherit"] },
  );
  return out;
}

const names = readdirSync(sourceDir)
  .filter((file) => file.endsWith(".mmd"))
  .map((file) => file.slice(0, -".mmd".length))
  .sort((a, b) => {
    const rank = (n) => (ORDER.indexOf(n) === -1 ? ORDER.length : ORDER.indexOf(n));
    return rank(a) - rank(b) || a.localeCompare(b);
  });

mkdirSync(outDir, { recursive: true });

const sections = [];
for (const name of names) {
  const source = readFileSync(join(sourceDir, `${name}.mmd`), "utf8");
  process.stdout.write(`${name} … `);
  render(name, "light");
  render(name, "dark");
  console.log("light + dark");
  sections.push({
    name,
    title: titleOf(source) ?? name,
    caption: CAPTIONS[name] ?? "",
  });
}

const html = `<title>PM Compass — Class Map</title>
<style>
  :root {
    --paper: #edefe9;
    --ink: #16232b;
    --ink-soft: #4a5a61;
    --ink-faint: #7c8a8f;
    --blue: #2b5f82;
    --amber: #a85a17;
    --line: #b9c2b4;
    --card-bg: #f7f8f3;
    --font-display: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    --font-body: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --font-mono: ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Consolas, "Liberation Mono", monospace;
  }

  :root[data-theme="dark"] {
    --paper: #0e2233;
    --ink: #e7eff3;
    --ink-soft: #a9c0cd;
    --ink-faint: #71909f;
    --blue: #7cbbe4;
    --amber: #f2a65a;
    --line: #2c4f68;
    --card-bg: #102840;
  }

  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --paper: #0e2233;
      --ink: #e7eff3;
      --ink-soft: #a9c0cd;
      --ink-faint: #71909f;
      --blue: #7cbbe4;
      --amber: #f2a65a;
      --line: #2c4f68;
      --card-bg: #102840;
    }
  }

  * { box-sizing: border-box; }

  html, body {
    margin: 0;
    padding: 0;
    background: var(--paper);
    color: var(--ink);
    font-family: var(--font-body);
    overflow-x: hidden;
  }

  body {
    padding: 0 0 72px;
    background-image:
      linear-gradient(color-mix(in srgb, var(--line) 55%, transparent) 1px, transparent 1px),
      linear-gradient(90deg, color-mix(in srgb, var(--line) 55%, transparent) 1px, transparent 1px);
    background-size: 34px 34px;
    background-position: -1px -1px;
    background-attachment: local;
  }

  a { color: inherit; }

  code {
    font-family: var(--font-mono);
    font-size: 0.92em;
    background: color-mix(in srgb, var(--line) 30%, transparent);
    border-radius: 3px;
    padding: 1px 5px;
  }

  .masthead {
    padding: 52px 28px 34px;
    border-bottom: 2px solid var(--ink);
    max-width: 1280px;
    margin: 0 auto;
  }

  .eyebrow {
    font-family: var(--font-mono);
    font-size: 12.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--blue);
    margin-bottom: 14px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .eyebrow::before {
    content: "";
    width: 22px;
    height: 1px;
    background: var(--blue);
    display: inline-block;
  }

  h1 {
    font-family: var(--font-display);
    font-weight: 800;
    font-size: clamp(28px, 4vw, 42px);
    letter-spacing: -0.01em;
    margin: 0 0 12px;
    text-wrap: balance;
  }

  .dek {
    font-size: 16px;
    line-height: 1.55;
    color: var(--ink-soft);
    max-width: 62ch;
    margin: 0;
  }

  .generated {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--amber);
    border: 1px solid var(--amber);
    border-radius: 3px;
    padding: 8px 11px;
    margin: 22px 0 0;
    max-width: 62ch;
    line-height: 1.5;
  }

  section {
    max-width: 1280px;
    margin: 0 auto;
    padding: 0 28px;
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: 14px;
    margin: 56px 0 10px;
  }
  .num {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--amber);
    border: 1px solid var(--amber);
    border-radius: 3px;
    padding: 2px 6px;
  }
  h2 {
    font-family: var(--font-display);
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 15px;
    margin: 0;
  }

  .caption {
    font-size: 13.5px;
    line-height: 1.55;
    color: var(--ink-soft);
    max-width: 74ch;
    margin: 0 0 16px;
  }

  figure {
    margin: 0;
    background: var(--card-bg);
    border: 1.5px solid var(--ink);
    border-radius: 5px;
    padding: 18px;
    overflow-x: auto;
  }

  figure img {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 0 auto;
  }

  img.dark { display: none; }
  :root[data-theme="dark"] img.light { display: none; }
  :root[data-theme="dark"] img.dark { display: block; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) img.light { display: none; }
    :root:not([data-theme="light"]) img.dark { display: block; }
  }

  footer {
    max-width: 1280px;
    margin: 60px auto 0;
    padding: 20px 28px 0;
    border-top: 2px solid var(--ink);
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--ink-faint);
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
  }

  @media (max-width: 640px) {
    .masthead { padding: 40px 18px 26px; }
    section { padding: 0 18px; }
  }
</style>

<header class="masthead">
  <div class="eyebrow">pm-compass · src</div>
  <h1>Class relationships</h1>
  <p class="dek">
    Every hierarchy in the plugin, and what each class holds, builds or listens to. What each
    one is <em>for</em> is in <a href="data-model.md">docs/technical/data-model.md</a>, which walks the
    same diagrams class by class.
  </p>
  <p class="generated">
    Generated by <code>pnpm docs:diagrams</code> — edit <code>docs/technical/diagrams/*.mmd</code>,
    not this file.
  </p>
</header>
${sections
  .map(
    (section, index) => `
<section>
  <div class="head">
    <span class="num">${String(index + 1).padStart(2, "0")}</span>
    <h2>${section.title}</h2>
  </div>
  ${section.caption ? `<p class="caption">${section.caption}</p>` : ""}
  <figure>
    <img class="light" src="diagrams/out/${section.name}-light.svg" alt="${section.title}">
    <img class="dark" src="diagrams/out/${section.name}-dark.svg" alt="${section.title}">
  </figure>
</section>`,
  )
  .join("\n")}

<footer>
  <span>pm-compass · src — ${sections.length} diagrams from docs/technical/diagrams/</span>
  <span>generated — run <code>pnpm docs:diagrams</code> after editing a source</span>
</footer>
`;

// The prose docs show the same sources as ```mermaid fences, which GitHub draws itself. They
// are copied in rather than written twice: a fence edited by hand is a diagram that disagrees
// with the page beside it. Which doc holds which diagram is the markers' to say, so a source
// moved from one to the other needs nothing here.
function withFences(markdown, doc, embedded) {
  let filled = markdown;
  for (const { name } of sections) {
    const marker = new RegExp(`(<!-- diagram:${name} -->\\n)[\\s\\S]*?(<!-- /diagram -->)`);
    if (!marker.test(filled)) continue;
    const source = readFileSync(join(sourceDir, `${name}.mmd`), "utf8").trimEnd();
    filled = filled.replace(marker, `$1\n\`\`\`mermaid\n${source}\n\`\`\`\n\n$2`);
    const held = embedded.get(name);
    if (held) failures.push(`<!-- diagram:${name} --> is in both ${held} and ${doc}`);
    embedded.set(name, doc);
  }
  return filled;
}

const embedded = new Map();
const docs = proseDocs.map((path) => {
  const markdown = readFileSync(path, "utf8");
  const doc = path.slice(root.length + 1);
  return { path, markdown, filled: withFences(markdown, doc, embedded) };
});
for (const { name } of sections) {
  if (!embedded.has(name)) failures.push(`no prose doc has a <!-- diagram:${name} --> marker`);
}

if (check) {
  rmSync(outDir, { recursive: true, force: true });
  for (const { path, markdown, filled } of docs) {
    if (filled !== markdown) {
      failures.push(`${path.slice(root.length + 1)}'s fences are behind docs/technical/diagrams/*.mmd`);
    }
  }
  for (const { name, title } of sections) {
    for (const theme of ["light", "dark"]) {
      const committed = join(sourceDir, "out", `${name}-${theme}.svg`);
      if (!existsSync(committed) || statSync(committed).size === 0) {
        failures.push(`docs/technical/diagrams/out/${name}-${theme}.svg is missing`);
      }
    }
    if (!readFileSync(page, "utf8").includes(`${name}-light.svg`)) {
      failures.push(`docs/technical/class-map.html does not show ${name} (${title})`);
    }
  }
  if (failures.length > 0) {
    console.error(`\n${failures.join("\n")}\n\nRun \`pnpm docs:diagrams\` and commit what it writes.`);
    process.exit(1);
  }
  console.log("\nsources, page and fences agree");
} else {
  writeFileSync(page, html);
  console.log(`\ndocs/technical/class-map.html — ${sections.length} diagrams`);
  for (const { path, filled } of docs) {
    writeFileSync(path, filled);
    console.log(`${path.slice(root.length + 1)} — fences in step with the sources`);
  }
  if (failures.length > 0) console.log(failures.map((line) => `  (${line})`).join("\n"));
}
