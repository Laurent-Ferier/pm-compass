import { App, normalizePath } from "obsidian";

/** Reads the projectsFolder setting from obsidian-pm's data.json. Returns null if unavailable. */
export async function readObsidianPmSettings(
  app: App,
): Promise<{ projectsFolder: string } | null> {
  try {
    const path = normalizePath(
      `${app.vault.configDir}/plugins/obsidian-pm/data.json`,
    );
    const raw = await app.vault.adapter.read(path);
    const data = JSON.parse(raw) as { projectsFolder?: string };
    return data.projectsFolder ? { projectsFolder: data.projectsFolder } : null;
  } catch {
    return null;
  }
}
