import type { App } from "obsidian";
import { TaskService } from "../service/task-service";
import { DEFAULT_SETTINGS, type PMCompassSettings } from "../settings";
import { notesOf } from "./notes";

/**
 * A real `TaskService` over a mock app, built the way `VaultData` builds it: the cache it
 * makes is the one the vault hands back, so a write made through the service is read back
 * through the same cache — and `DayNoteService` reaches that cache to read a note it made.
 *
 * The daily-notes scheme is left as the guess `TaskService` starts on, which is what a vault
 * with no `daily-notes.json` resolves to anyway.
 */
export function serviceOver(app: App, overrides: Partial<PMCompassSettings> = {}): TaskService {
  const settings = { ...DEFAULT_SETTINGS, ...overrides };
  const data = Object.assign(notesOf(app), { settings: () => settings });
  const service = new TaskService(data);
  Object.assign(data, { tasks: service });
  return service;
}
