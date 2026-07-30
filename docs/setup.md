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

Other useful commands from the repo root: `pnpm lint`, `pnpm test:coverage`,
`pnpm test:watch`, `pnpm test:bundle`.

`pnpm typecheck` covers `*.test.ts` too. Test files were excluded from `tsconfig.json`
for a long time, which let their fakes and fixtures drift out of step with the code
they exercise — an editor would flag it, CI never would. Two consequences worth knowing
when writing tests: a fake that stands in for a large interface (`App`, `Moment`) must
be asserted to it, by convention once at its factory rather than at every call site
(see `model/__testing__/as-moment.ts`), and a shared fixture object needs its real type
annotation (`CreateTaskOpts`, `EffectiveValues`, …) or its fields widen to `string` and
stop matching.

## Build the plugin

```bash
pnpm build       # minified, no sourcemap — exactly what a release ships
pnpm build:dev   # readable, with an inline sourcemap
pnpm dev         # watch build; implies --dev
```

Either produces `main.js`. Obsidian also needs `manifest.json` and `styles.css`
alongside it in `<vault>/.obsidian/plugins/pm-compass/`.

`pnpm build` is the default so that what is tested locally is what users run. Reach
for `build:dev` when a stack trace or a step through the debugger has to name real
functions — it costs about eight times the size, three quarters of it sourcemap.

### Checking the bundle

```bash
pnpm test:bundle
```

Vitest runs against `src/`, so it never sees the shipped bundle: a name mangled by
minification would pass every test and still break the plugin. `scripts/smoke-bundle.mjs`
loads the built `main.js` against a stub of the Obsidian API, runs `onload`, and asserts
the view types, command ids, ribbon icons and setting tab it registers. It refuses to run
against a `--dev` bundle, since that would leave the shipped one unchecked. CI runs it
between the build and the provenance attestation.

### Installing into a vault

Two helper scripts do the build-and-copy step for you. Both take `--dev` to install a
readable bundle rather than the minified one:

- **`scripts/link-plugin.sh [--dev] <vault-path>`** — builds, then *symlinks*
  `main.js`/`manifest.json`/`styles.css` into the vault. Preferred for local
  development: once linked, rebuilding (`pnpm dev` for a watch build)
  is picked up by Obsidian without re-copying anything. The links outlive the build,
  so a later `pnpm build:dev` swaps what the vault loads without re-running the script.
- **`scripts/update-plugin.sh [--dev] <vault-path>`** — builds, then *copies* the same three
  files. Use this for a one-off install that doesn't need the source repo to stick
  around.

Both scripts create `<vault>/.obsidian/plugins/pm-compass/` if it doesn't exist yet,
and both require Obsidian to be reloaded (or the plugin toggled off/on) to pick up a
fresh build.

### Testing on a phone

Obsidian's mobile stylesheet overrides plugin layout in ways that don't reproduce by
narrowing a desktop window, so layout changes are worth checking on a real device.

- **`scripts/deploy-android.sh [--dev] <vault-path>`** — builds, pushes the plugin to a
  USB-connected Android phone (`adb`), restarts Obsidian so the new CSS/JS is read,
  and optionally screenshots it (`--shot <file>`). `--list` prints the vaults it finds
  on the device; `--dev` pushes a readable bundle, which is what makes a stack trace
  from the phone legible; `--help` documents the rest.

It also forwards Obsidian's WebView debugger to `localhost:9222`, so the live DOM can
be inspected — computed styles, element boxes — rather than guessing at why a rule
loses. See the comments at the top of the script.

## Releasing

`scripts/release.mjs` (invoked as `pnpm release <version>`) bumps the version in
`manifest.json`/`package.json`/`versions.json`, runs typecheck → test → lint → build →
test:bundle, commits and tags, and copies `main.js`/`manifest.json`/`styles.css` into `release/`
for attaching to the GitHub release. See the usage comment at the top of that file for
the full flag reference (`--dry-run`, `--force`).
