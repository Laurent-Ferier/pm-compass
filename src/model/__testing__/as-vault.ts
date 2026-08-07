import type { VaultData } from "../service/vault-data";
import { corePluginEnabled, templaterOf } from "../service/app-plugins";
import { asApp } from "./as-app";

/**
 * The vault over a mock app, holding no store and having read nothing — what the passes
 * taking `VaultData` need to reach the app through it. The plugins around this one answer
 * as they would on a real vault, off the same reading `VaultData` uses; anything else is
 * absent, a test standing this up asking nothing of the caches.
 */
export function asVault<T>(mock: T): VaultData {
  const app = asApp(mock);
  return {
    app,
    get templater() { return templaterOf(app); },
    corePluginEnabled: (id: string) => corePluginEnabled(app, id),
  } as unknown as VaultData;
}
