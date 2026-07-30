/**
 * An object seen as a bag of properties, for hanging on it what jsdom has no notion of:
 * Obsidian's element helpers (`createEl`, `addClass`, `isShown`) and the globals it
 * installs on the window (`activeDocument`, `ResizeObserver`). Only the assignment needs
 * this — Obsidian's own type augmentations still check every later use.
 */
export function bagOf(target: object): Record<string, unknown> {
  return target as unknown as Record<string, unknown>;
}
