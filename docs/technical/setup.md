# Setup

## Requirements

- [pnpm](https://pnpm.io) ≥ 10
- Node.js ≥ 22
- [obsidian-pm](https://github.com/stepankropachev/obsidian-pm) installed in your vault

## Install & verify

```bash
pnpm install
pnpm typecheck
pnpm test
```

Other commands are in `package.json`'s `scripts` — `lint`, `test:coverage`, `test:watch`, `test:bundle`.

`pnpm typecheck` covers `*.test.ts` too, which has two consequences when writing tests: a fake standing in for a large interface (`App`, `Moment`) must be asserted to it, by convention once at its factory rather than at every call site (see `model/__testing__/as-moment.ts`), and a shared fixture object needs its real type annotation (`CreateTaskOpts`, `EffectiveValues`, …) or its fields widen to `string` and stop matching.

## Build the plugin

```bash
pnpm build       # minified, no sourcemap — exactly what a release ships
pnpm build:dev   # readable, with an inline sourcemap
pnpm dev         # watch build; implies --dev
```

Either produces `main.js`. Obsidian also needs `manifest.json` and `styles.css` alongside it in `<vault>/.obsidian/plugins/pm-compass/`. `pnpm build` is the default so that what is tested locally is what users run; reach for `build:dev` when a stack trace has to name real functions, at about eight times the size.

### Checking the bundle

`pnpm test:bundle` runs `scripts/smoke-bundle.mjs`, which loads the built `main.js` against a stub of the Obsidian API, runs `onload()`, and asserts the view types, command ids, ribbon icons and setting tab it registers. Vitest runs against `src/`, so it never sees the shipped bundle: a name mangled by minification would pass every test and still break the plugin. It refuses to run against a `--dev` bundle, and CI runs it between the build and the provenance attestation.

### Installing into a vault

Two helper scripts build and copy for you; both take `--dev`, create the plugin folder if needed, and require Obsidian to be reloaded to pick up a fresh build. Run either with `--help` for the full flag reference.

- **`scripts/link-plugin.sh [--dev] <vault-path>`** *symlinks* the three files. Preferred for local development: once linked, rebuilding (`pnpm dev`) is picked up without re-running the script.
- **`scripts/update-plugin.sh [--dev] <vault-path>`** *copies* them instead, for a one-off install that doesn't need the source repo to stick around.

### Testing on a phone

Obsidian's mobile stylesheet overrides plugin layout in ways that don't reproduce by narrowing a desktop window, so layout changes are worth checking on a real device. **`scripts/deploy-android.sh [--dev] <vault-path>`** builds, pushes the plugin to a USB-connected Android phone (`adb`), restarts Obsidian, and optionally screenshots it (`--shot <file>`); `--list` prints the vaults it finds on the device. It also forwards Obsidian's WebView debugger to `localhost:9222`, so the live DOM can be inspected — computed styles, element boxes — rather than guessing at why a rule loses.

`docs/technical/preview/cdp.mjs` evaluates an expression in that WebView and prints the result (no dependencies — it uses Node's global `WebSocket`):

```bash
node docs/technical/preview/cdp.mjs "app.plugins.plugins['pm-compass'].manifest.version"

# switch tabs and measure, which nothing else can do:
node docs/technical/preview/cdp.mjs "(async () => {
  const v = app.workspace.getLeavesOfType('pm-compass-dashboard')[0].view;
  v.activeTab = 'tasks'; await v.render();
  const r = (s) => { const q = document.querySelector(s).getBoundingClientRect();
    return Math.round(q.left) + '..' + Math.round(q.right) + ' h' + Math.round(q.height); };
  return JSON.stringify({ bar: r('.pm-dash-date-nav'), label: r('.pm-dash-date-text') });
})()"
```

`activeTab` is `"inbox"`, `"tasks"` or `"stats"`. The view skips rebuilds while it is off-screen, so reveal its leaf first if the drawer is closed.

## The documentation diagrams

The class diagrams in [data-model.md](data-model.md) are generated. Their sources are `docs/technical/diagrams/*.mmd`, and one pass renders them everywhere they appear:

```bash
pnpm docs:diagrams         # renders, and writes the page and the fences
pnpm docs:diagrams:check   # asserts every source still draws and is embedded — what CI runs
```

It writes three things: an SVG per source under `diagrams/out/`, rendered twice because mermaid bakes the text colour in and one rendering is unreadable in one of the two themes; [class-map.html](class-map.html), the same drawings on one page for reading offline; and the ```` ```mermaid ```` fences in the prose, which GitHub draws itself. **Never edit a fence by hand** — edit the `.mmd` and re-run the pass. Both the SVGs and the page are committed, so reading the docs needs no mermaid; only editing a diagram does.

A new source needs two things beyond the file: an entry in `CAPTIONS` in [render-diagrams.mjs](../../scripts/render-diagrams.mjs), which is what orders the page, and a `<!-- diagram:name -->` / `<!-- /diagram -->` pair for the fence to land in, in one of the docs `proseDocs` lists — [data-model.md](data-model.md) or [task-listings.md](task-listings.md). Which doc holds a diagram is the marker's to say; a source no doc embeds fails the check.

`--check` compares the *sources* against what the docs embed rather than the committed SVGs byte for byte: mermaid measures text to lay a diagram out, so the same source drawn against a different font list is a different file, and a byte comparison would fail on the runner rather than on anything anyone wrote.

## Previewing a style change in a browser

`docs/technical/preview/tabs.html` renders the plugin's **real DOM**, captured from the running app (`tabs.js`), against the repo's own `styles.css` — no device needed. None of it is part of the build. Open it in a browser and click anything: the captured markup carries no handlers, so every click reports that element's `pm-` classes, its rendered size, and the chain of elements it sits in. The only thing the page draws over the markup is a dashed line at the tab's centre, which is what the bar's middle grid column is meant to hold. The button at the top right switches the shimmed Obsidian variables between dark and light, and `tabs.html#light` opens on light — see [theming.md](theming.md).

Re-render the screenshot after a CSS change:

```bash
cd docs/technical/preview
google-chrome --headless=new --no-sandbox --disable-gpu --allow-file-access-from-files \
  --hide-scrollbars --virtual-time-budget=3000 --window-size=1500,1420 \
  --screenshot=tabs.png "file://$PWD/tabs.html"
```

For a computed value neither the render nor the inspector shows — how a `minmax()` resolved, the size of each grid track — append a throwaway line to `tabs.html` that writes it into a `<pre id="probe">`, then read it back with `--dump-dom` instead of `--screenshot` and grep for `id="probe"`.

**Re-capturing the markup** is needed only when the markup itself changes — a new row part, a section that moved. `capture.mjs` reads the live DOM over the WebView debugger and rewrites `tabs.js`, replacing every task, project and habit name with sample text and stripping every `title`/`aria-label` **on the device, before the markup is serialised**:

```bash
./scripts/deploy-android.sh /sdcard/<vault>    # puts the debugger on localhost:9222
node docs/technical/preview/capture.mjs
```

Check what came back before committing it — the word list `tabs.js` yields should hold no real note titles.

## Releasing

`scripts/release.mjs` (invoked as `pnpm release <version>`) bumps the version in `manifest.json`/`package.json`/`versions.json`, runs typecheck → test → lint → build → test:bundle, commits and tags, and copies `main.js`/`manifest.json`/`styles.css` into `release/` for attaching to the GitHub release. See the usage comment at the top of that file for the full flag reference (`--dry-run`, `--force`).
