import type { App } from "obsidian";

/**
 * Widens a mock to the full `App` the code under test takes, while keeping each stub's
 * own type so a test can still read `.mock` and re-stub with `mockImplementation`.
 * The import is type-only, so this adds nothing to what a test's `vi.mock("obsidian", …)`
 * has to provide.
 */
export function asApp<T>(mock: T): T & App {
  return mock as unknown as T & App;
}
