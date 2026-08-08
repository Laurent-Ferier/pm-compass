import type { App } from "obsidian";
import type { PMCompassSettings } from "../settings";
import type { VaultData } from "./vault-data";

/**
 * What both halves of the vault have above their caches. A service holds no note — the caches
 * below it do — and what it owns is what spans them: the settings they are read under, the
 * writes that touch a second note, and the passes that put notes back in step. What it has of
 * its own is the vault it works on, and through it the app and the settings as they now stand.
 *
 * `TaskService` over the day notes and the inbox, `ProjectService` over the projects folder,
 * are the two halves; `DayNoteService`, over where a day's note lives, sits beside them with
 * no cache of its own.
 */
export abstract class BaseService {
  constructor(protected readonly vault: VaultData) {}

  /** The vault as Obsidian hands it over. */
  protected get app(): App {
    return this.vault.app;
  }

  /** The settings as they now stand, read on each use — a service that kept a copy would
   *  answer with what they said when it was built. */
  protected settings(): PMCompassSettings {
    return this.vault.settings();
  }
}
