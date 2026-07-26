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
`pnpm test:watch`.

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
pnpm build
```

This produces `main.js`. Obsidian also needs `manifest.json` and `styles.css`
alongside it in `<vault>/.obsidian/plugins/pm-compass/`.

### Installing into a vault

Two helper scripts do the build-and-copy step for you:

- **`scripts/link-plugin.sh <vault-path>`** — builds, then *symlinks*
  `main.js`/`manifest.json`/`styles.css` into the vault. Preferred for local
  development: once linked, rebuilding (`pnpm dev` for a watch build)
  is picked up by Obsidian without re-copying anything.
- **`scripts/update-plugin.sh <vault-path>`** — builds, then *copies* the same three
  files. Use this for a one-off install that doesn't need the source repo to stick
  around.

Both scripts create `<vault>/.obsidian/plugins/pm-compass/` if it doesn't exist yet,
and both require Obsidian to be reloaded (or the plugin toggled off/on) to pick up a
fresh build.

### Testing on a phone

Obsidian's mobile stylesheet overrides plugin layout in ways that don't reproduce by
narrowing a desktop window, so layout changes are worth checking on a real device.

- **`scripts/deploy-android.sh <vault-path>`** — builds, pushes the plugin to a
  USB-connected Android phone (`adb`), restarts Obsidian so the new CSS/JS is read,
  and optionally screenshots it (`--shot <file>`). `--list` prints the vaults it finds
  on the device; `--help` documents the rest.

It also forwards Obsidian's WebView debugger to `localhost:9222`, so the live DOM can
be inspected — computed styles, element boxes — rather than guessing at why a rule
loses. See the comments at the top of the script.

## Releasing

`scripts/release.mjs` (invoked as `pnpm release <version>`) bumps the version in
`manifest.json`/`package.json`/`versions.json`, runs typecheck → test → lint → build,
commits and tags, and copies `main.js`/`manifest.json`/`styles.css` into `release/`
for attaching to the GitHub release. See the usage comment at the top of that file for
the full flag reference (`--dry-run`, `--force`).
