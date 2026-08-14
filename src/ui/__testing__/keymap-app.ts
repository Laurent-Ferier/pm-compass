import type { App, Scope } from "obsidian";
import { asApp } from "../../model/__testing__/as-app";

/** A scope as the mock builds it: what was registered on it, in order. */
type MockScope = Scope & { parent?: MockScope; handlers: { key: string | null; run: () => boolean | void }[] };

/** What an app-wide hotkey is bound to in this stand-in app. A press of it is answered only
 *  where the scope on top let the key through to the app's own. */
export const GLOBAL_KEY = "P";

export interface KeymapApp {
  app: App;
  /** Presses a key the way Obsidian does: the scope pushed last first, then its parents,
   *  stopping at the handler that answers `false`. Returns whether one did. */
  press: (key: string) => boolean;
  /** The scopes still pushed, oldest first — what a test asserts a popup cleaned up. */
  scopes: MockScope[];
}

/** An app carrying a keymap the popups can push a scope onto, and a test can press keys at. */
export function keymapApp(): KeymapApp {
  const scopes: MockScope[] = [];
  const app = asApp({
    scope: { handlers: [{ key: GLOBAL_KEY, run: () => false }] } as unknown as MockScope,
    keymap: {
      pushScope: (scope: MockScope) => { scopes.push(scope); },
      popScope: (scope: MockScope) => {
        const i = scopes.indexOf(scope);
        if (i >= 0) scopes.splice(i, 1);
      },
    },
  });

  const press = (key: string): boolean => {
    for (let scope = scopes[scopes.length - 1]; scope; scope = scope.parent!) {
      for (const h of scope.handlers) {
        if (h.key === key && h.run() === false) return true;
      }
    }
    return false;
  };

  return { app, press, scopes };
}
