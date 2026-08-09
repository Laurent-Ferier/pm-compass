import { describe, it, expect } from "vitest";
import { BaseService } from "./base-service";
import type { VaultData } from "./vault-data";
import type { App } from "obsidian";
import type { PMCompassSettings } from "../settings";
import { asApp } from "../__testing__/as-app";

/** What both halves of the vault have above their caches, opened up to the test. */
class Service extends BaseService {
  get theApp(): App {
    return this.app;
  }

  get folder(): string {
    return this.settings().projectsFolder;
  }
}

function vaultOf(app: App, settings: () => PMCompassSettings): VaultData {
  return { app, settings } as unknown as VaultData;
}

describe("BaseService", () => {
  it("reaches the app through the vault it works on", () => {
    const app = asApp({});

    expect(new Service(vaultOf(app, () => ({}) as PMCompassSettings)).theApp).toBe(app);
  });

  it("reads the settings on each use, rather than the ones it was made under", () => {
    let folder = "Projects";
    const service = new Service(vaultOf(asApp({}), () => ({ projectsFolder: folder }) as PMCompassSettings));

    expect(service.folder).toBe("Projects");
    folder = "Work";

    expect(service.folder).toBe("Work");
  });
});
