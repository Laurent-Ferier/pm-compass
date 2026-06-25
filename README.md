# pm-compass

Personal extensions built on top of [obsidian-pm](https://github.com/stepankropachev/obsidian-pm) data.

Reads project and task notes created by the obsidian-pm plugin and the Obsidian Daily Notes core plugin to add personal workflows: analytics dashboard, daily digest, and AI-assisted insights.

## Packages

| Package | Description |
|---|---|
| `packages/plugin` | Obsidian plugin — sidebar views inside Obsidian |
| `packages/cli` | Terminal automation tool — cron-friendly commands |
| `packages/shared` | Shared TypeScript types (no runtime deps) |

## Requirements

- [pnpm](https://pnpm.io) ≥ 10
- Node.js ≥ 22
- [obsidian-pm](https://github.com/stepankropachev/obsidian-pm) installed in your vault

## Setup

```bash
pnpm install
pnpm typecheck
pnpm test
```

### Build the plugin

```bash
pnpm --filter plugin build
```

Copy `packages/plugin/main.js` and `packages/plugin/manifest.json` into your vault's `.obsidian/plugins/pm-compass/` folder.

### CLI

```bash
node packages/cli/src/index.ts --help
```
