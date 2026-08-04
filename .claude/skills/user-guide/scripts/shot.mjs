// Screenshot the plugin as it runs on a USB-connected phone, with every piece of vault
// content replaced by sample text before the pixels exist, cropped to one element.
// Needs `adb` on the path and ImageMagick's `magick` for the crop.
//
//   ./scripts/deploy-android.sh /sdcard/<vault>    # forwards the WebView debugger to :9222
//   node .claude/skills/user-guide/scripts/shot.mjs out.png '<setup js>' '<post js>'
//
// `setup` runs first (settings, tab, scroll position), then the anonymize pass, then `post`
// (opening a row's toolbar, choosing what to crop). Both are evaluated in the page, where
// `plugin`, `leaf`, `host` and `anonymize()` are already in scope. Crop with:
//
//   window.__crop = <element>   the element to frame; defaults to the whole plugin panel
//   window.__pad = <css px>     grows the frame on every side
//   window.__trimBottom = <px>  cuts Obsidian's floating mobile toolbar off the bottom
//
// Settings changed in `setup` are changed in memory only — restore them afterwards, and
// re-render, so the device is left as it was found.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

const [, , out, setup = "", post = ""] = process.argv;
if (!out) { console.error("usage: shot.mjs <out.png> [setup js] [post js]"); process.exit(1); }

const targets = await (await fetch("http://localhost:9222/json/list")).json();
const page = targets.find((t) => t.type === "page" && t.url.startsWith("http://localhost"));
if (!page) { console.error("no page target — is the debugger forward up?"); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  const resolve = pending.get(msg.id);
  if (resolve) { pending.delete(msg.id); resolve(msg); }
});
const evaluate = (expression) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => reject(new Error(`timed out waiting for evaluate #${id}`)), 30000);
  pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
  ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
});

// Same replacement lists as docs/preview/capture.mjs, applied to the live DOM rather than to
// a clone: what is screenshotted has to be what was scrubbed.
const PRELUDE = `
  const TASKS = ['Draft the scoping note','Review the supplier quote','Prepare Friday\\'s demo',
    'Sort the weekend photos','Call the garage','Split the budget into lots','Write the parser tests',
    'Tidy the workshop','Answer the call for tenders','Plan the summer leave','Update the schema',
    'Order the spare parts','Book the meeting room','Renew the subscription','Fix the leaking tap',
    'Send the invoice','Compare the two offers','Back up the photos','Chase the missing delivery',
    'Draft the release notes','Clear the download folder','Check the tyre pressure'];
  const PROJECTS = ['Project Alpha','Project Bravo','House','Tech watch','Garden','Reading list',
    'Client work','Home lab'];
  const HABITS = ['Walk 30 minutes','Read 10 pages','Review the day','Stretching','Drink 1.5 L',
    'Evening journal','Tidy the desk','Five minutes of quiet'];
  const anonymize = (root) => {
    let t = 0, p = 0, h = 0;
    root.querySelectorAll('.pm-dash-item-text').forEach((el) => { el.textContent = HABITS[h++ % HABITS.length]; });
    root.querySelectorAll('.pm-dash-checklist-text, .pm-inbox-title, .pm-dash-task-title, .pm-tm-row-label')
      .forEach((el) => {
        const habit = el.closest('.pm-day-task-row')?.querySelector('.pm-dash-checklist-daily-icon');
        el.textContent = habit ? HABITS[h++ % HABITS.length] : TASKS[t++ % TASKS.length];
      });
    root.querySelectorAll('.pm-dash-task-project, .pm-dash-habit-name, .pm-dash-stat-task')
      .forEach((el) => { el.textContent = PROJECTS[p++ % PROJECTS.length]; });
    // The graph names the same things on its cards, its frame and its trail.
    root.querySelectorAll('.pm-node-title').forEach((el) => { el.textContent = TASKS[t++ % TASKS.length]; });
    root.querySelectorAll('.pm-node-project-title, .pm-graph-container-header, .pm-breadcrumb-item')
      .forEach((el) => {
        // The trail's first entry names no project — it is where the projects themselves are.
        if (el.textContent !== 'All') el.textContent = PROJECTS[p++ % PROJECTS.length];
      });
    root.querySelectorAll('.pm-inbox-file-name').forEach((el) => { el.textContent = 'Inbox.md'; });
    // Tooltips and labels quote the vault's own words back, and none of it shows in a render.
    root.querySelectorAll('[title], [aria-label]').forEach((el) => {
      el.removeAttribute('title'); el.removeAttribute('aria-label');
    });
    root.querySelectorAll('.pm-day-task-note-line').forEach((el) => { el.textContent = 'A note attached to the task.'; });
  };
  const plugin = app.plugins.plugins['pm-compass'];
  const leaf = app.workspace.getLeavesOfType('pm-compass-dashboard')[0];
  const host = leaf.view;
  // Reset every frame knob: the page outlives one run of this script.
  window.__crop = null; window.__pad = 0; window.__trimBottom = 0;
`;

const msg = await evaluate(`(async () => {
  ${PRELUDE}
  ${setup}
  anonymize(document.body);
  ${post}
  const target = window.__crop ?? document.querySelector('.pm-dash-container');
  const pad = window.__pad ?? 0, trim = window.__trimBottom ?? 0;
  const r = target.getBoundingClientRect();
  return JSON.stringify({ x: r.left - pad, y: r.top - pad, w: r.width + 2 * pad, h: r.height + 2 * pad - trim, dpr: devicePixelRatio });
})()`);

const value = msg.result?.result?.value;
if (typeof value !== "string") { console.error(JSON.stringify(msg.result)); process.exit(1); }
const box = JSON.parse(value);
if (box.w <= 0 || box.h <= 0) { console.error("empty crop", value); process.exit(1); }
console.error("frame", value);

const raw = `${out}.raw.png`;
execFileSync("bash", ["-c", `adb exec-out screencap -p > ${JSON.stringify(raw)}`]);
const px = (n) => Math.round(n * box.dpr);
execFileSync("magick", [raw, "-crop", `${px(box.w)}x${px(box.h)}+${px(box.x)}+${px(box.y)}`, "+repage", out]);
// The whole-screen grab is scaffolding; leaving it beside the crop puts an unanonymized
// screenshot of the device next to every figure taken.
rmSync(raw, { force: true });
console.error("wrote", out);
process.exit(0);
