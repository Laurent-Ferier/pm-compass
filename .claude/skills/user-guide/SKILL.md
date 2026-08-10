---
name: user-guide
description: Write or refresh a user-facing guide for one of the plugin's tabs or features (docs/guide/dashboard.md and its kin) — illustrated with real, anonymized screenshots taken from the app running on a connected device. Use when asked to document what a screen shows, what its rows and buttons do, or to turn a technical doc into something a user can read.
---

# Writing a user guide

A user guide says what is on screen and what it does. It is not a description of the code, and it is not a description of itself.

## Structure

In this order, one `##` per step:

1. **One sentence** saying what the screen is and why it exists. No preamble about what the document covers.
2. **The screen** — one full screenshot, then only what a reader can't see in it: what governs the whole view (the selected day, the current week, the picked project), and what the screen writes to.
3. **The displays** — one subsection per arrangement that genuinely looks different, each with its own figure. Name the settings by the label the settings screen shows, in bold. A variant that only removes headings needs a paragraph, not a screenshot.
4. **Kinds of item** — one subsection per kind of row, each with a close-up of that row with its buttons revealed, and a list of its actions (see below).
5. **Under the hood** — a few topics, as many as the screen actually has and no more: the ones that change how a user reads it. Everything mechanical from the sections above belongs here instead.

## Rules

- **Never name code.** No file, class, function, CSS class, or settings-key names — use the wording the app shows. A reader of this document does not have the repo open.
- **Keep it factual.** State what the screen does and stop. No selling ("a starting point, not a layout that is kept up"), no telling the reader what is theirs or what they are responsible for, no reassurance, no drawing a moral from a behaviour. Prefer the plain form: "each project keeps the place it was given" over "how the projects sit is yours to arrange and yours to keep".
- **Never describe the document or how it was made.** No "this document explains…", no note about how the screenshots were produced.
- **Never state what the screenshot already states.** A chevron folds a section, a button labelled Today goes to today, an ⓘ explains the section, a picker picks a date — all of it goes. What survives is what a screenshot cannot say: what the value affects, what happens to the file, what the rule is when the obvious case doesn't apply.
- **Each action is complete where it is listed.** One list entry per button, `icon` + bold label + everything worth knowing about it, including its variants and when it is absent. Never leave a trailing paragraph that explains one entry of a list above it.
- **Headings are short noun phrases** — "Ranking", not "How the ranking is decided".
- **Captions add, they don't repeat.** A caption says what this figure shows that the prose doesn't.
- **Link sibling docs** on the first mention of another screen, once per section.
- **Never hard-wrap prose.** One line per paragraph, list entry, heading or table row, however long it runs; the editor reading it soft-wraps. A newline starts a new block, nothing else.

## Screenshots

Take them from the app actually running, never from a mock-up. `scripts/shot.mjs` in this skill folder drives a phone over the WebView debugger, anonymizes the live DOM, screenshots the device and crops to an element (it shells out to `adb` and to ImageMagick's `magick`):

```bash
./scripts/deploy-android.sh /sdcard/<vault>      # deploys and forwards the debugger to :9222
node .claude/skills/user-guide/scripts/shot.mjs out.png '<setup js>' '<post js>'
```

If the forward has dropped but the app is still up, re-establish it without redeploying:

```bash
adb shell "cat /proc/net/unix | grep -o 'webview_devtools_remote_[0-9]*' | sort -u"
adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
```

Rules of the exercise:

- **Anonymize before the pixels exist.** The replacement pass runs in the page, on the live DOM; the screenshot is taken after it. Task, project and habit names become sample text and every `title`/`aria-label` is dropped. Check every image before committing it.
- **Leave the vault as you found it.** Change settings in memory only — never save them — and restore them (and any dialog, dropdown or injected element) with a final re-render.
- **Crop to an element**, not to guessed coordinates: `window.__crop` takes an element (or a `{getBoundingClientRect}` stand-in for a union of two), `__pad` grows it, `__trimBottom` cuts the phone's floating toolbar off the bottom.
- **Sizes**: full panels ~560px wide, row close-ups ~700px, stored in `docs/guide/images/`. Reference panels at `width="380"` and rows at `width="560"`.

## Icons

Show the app's real glyphs rather than describing them. Read them out of the running app — they are inline SVG in the DOM — and save each as its own file in `docs/guide/images/icons/`:

```bash
node docs/technical/preview/cdp.mjs "document.querySelector('svg.lucide-pencil').outerHTML"
```

Give each a fixed colour instead of `currentColor` (an `<img>` can't inherit the page's colour): mid-grey `#888888` for a button, the status's own colour for a status glyph. Set `width`/`height` to 16, drop the `class`, and reference them inline:

```markdown
- <img src="images/icons/pencil.svg" width="14" alt=""> **Edit title** — …
```

A glyph that isn't on screen anywhere can be reached by opening the UI that draws it (a modal, a filter toggle) rather than by hand-writing path data. Verify the whole set renders by injecting the files as `data:` images into the running app and screenshotting them — no local SVG rasterizer is installed, so a render check on the desktop proves nothing.
