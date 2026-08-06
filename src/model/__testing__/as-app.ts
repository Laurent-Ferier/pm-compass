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

/**
 * An app that answers "nothing there" to the reads a store takes, for a test standing one up
 * as a stand-in rather than to read through. A store watches whether or not a test is
 * looking — a write marks a model changed, and the window that closes on it puts the notes
 * back in step — so one built over a bare `asApp({})` spends the rest of the run logging
 * failures at a vault the test never meant to have.
 */
export function emptyApp(): App {
  return asApp({
    vault: {
      getAbstractFileByPath: () => null,
      read: () => Promise.resolve(""),
      cachedRead: () => Promise.resolve(""),
    },
    metadataCache: { getFileCache: () => null },
  });
}
