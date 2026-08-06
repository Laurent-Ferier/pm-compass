import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("obsidian", () => ({ normalizePath: (p: string) => p }));

import { readObsidianPmSettings } from "./obsidian-pm-settings";
import { asApp } from "../__testing__/as-app";

/** The vault's config folder, deliberately not the default `.obsidian`: the code under
 *  test has to read it off the vault rather than assume it. */
const CONFIG_DIR = ".vault-config";

function makeApp({
  adapterRead = (_path: string): Promise<string> => Promise.reject(new Error("ENOENT")),
  configDir = CONFIG_DIR,
}: {
  adapterRead?: (path: string) => Promise<string>;
  configDir?: string;
} = {}) {
  return asApp({ vault: { adapter: { read: adapterRead }, configDir } });
}

// ---------------------------------------------------------------------------
// readObsidianPmSettings
// ---------------------------------------------------------------------------

describe("readObsidianPmSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns projectsFolder when data.json contains it", async () => {
    const app = makeApp({
      adapterRead: async () =>
        JSON.stringify({ projectsFolder: "Work/Projects" }),
    });
    const result = await readObsidianPmSettings(app);
    expect(result).toEqual({ projectsFolder: "Work/Projects" });
  });

  it("returns null when data.json has no projectsFolder field", async () => {
    const app = makeApp({
      adapterRead: async () => JSON.stringify({ otherSetting: true }),
    });
    const result = await readObsidianPmSettings(app);
    expect(result).toBeNull();
  });

  it("returns null when data.json does not exist (read throws)", async () => {
    const app = makeApp({
      adapterRead: async () => {
        throw new Error("ENOENT");
      },
    });
    const result = await readObsidianPmSettings(app);
    expect(result).toBeNull();
  });

  it("returns null when data.json contains invalid JSON", async () => {
    const app = makeApp({ adapterRead: async () => "not valid json{{" });
    const result = await readObsidianPmSettings(app);
    expect(result).toBeNull();
  });

  it("reads from the correct path using configDir", async () => {
    const readSpy = vi.fn().mockResolvedValue(
      JSON.stringify({ projectsFolder: "MyProjects" }),
    );
    const app = makeApp({ adapterRead: readSpy, configDir: ".myconfig" });
    await readObsidianPmSettings(app);
    expect(readSpy).toHaveBeenCalledWith(
      ".myconfig/plugins/obsidian-pm/data.json",
    );
  });
});
