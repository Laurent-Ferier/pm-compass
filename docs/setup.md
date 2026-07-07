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

## Build the plugin

```bash
pnpm --filter plugin build
```

This produces `packages/plugin/main.js`. Obsidian also needs
`packages/plugin/manifest.json` and `packages/plugin/styles.css` alongside it in
`<vault>/.obsidian/plugins/pm-compass/`.

### Installing into a vault

Two helper scripts do the build-and-copy step for you:

- **`scripts/link-plugin.sh <vault-path>`** — builds, then *symlinks*
  `main.js`/`manifest.json`/`styles.css` into the vault. Preferred for local
  development: once linked, rebuilding (`pnpm --filter plugin dev` for a watch build)
  is picked up by Obsidian without re-copying anything.
- **`scripts/update-plugin.sh <vault-path>`** — builds, then *copies* the same three
  files. Use this for a one-off install that doesn't need the source repo to stick
  around.

Both scripts create `<vault>/.obsidian/plugins/pm-compass/` if it doesn't exist yet,
and both require Obsidian to be reloaded (or the plugin toggled off/on) to pick up a
fresh build.

## Releasing

`scripts/release.mjs` (invoked as `pnpm release <version>`) bumps the version in
`manifest.json`/`package.json`/`versions.json`, runs typecheck → test → lint → build,
commits and tags, and packages `main.js`/`manifest.json`/`styles.css` into a zip under
`release/`. See the usage comment at the top of that file for the full flag reference
(`--dry-run`, `--force`).
