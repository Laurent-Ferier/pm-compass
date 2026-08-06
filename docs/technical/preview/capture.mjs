// Grab each tab's rendered body from the running plugin, with every piece of vault content
// replaced by sample text before it leaves the device. Writes tabs.js, which tabs.html reads.
//
//   ./scripts/deploy-android.sh <vault>   # puts the WebView debugger on localhost:9222
//   node docs/technical/preview/capture.mjs
import { writeFileSync } from "node:fs";

const targets = await (await fetch("http://localhost:9222/json/list")).json();
const page = targets.find((t) => t.type === "page" && t.url.startsWith("http://localhost"));
if (!page) { console.error("no page target — is deploy-android.sh's forward up?"); process.exit(1); }

const die = (why) => { console.error(why); process.exit(1); };

const ws = new WebSocket(page.webSocketDebuggerUrl);
// A dropped phone, a locked screen, a render that never settles: every one of them leaves
// a reply outstanding, so nothing here waits on the WebView without a way out.
ws.addEventListener("error", () => die("socket error — is the device still attached?"));
ws.addEventListener("close", () => die("socket closed before every tab came back"));
await new Promise((r) => ws.addEventListener("open", r));
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  const resolve = pending.get(msg.id);
  if (resolve) { pending.delete(msg.id); resolve(msg); }
});
const evaluate = (expression) => new Promise((resolve) => {
  const id = nextId++;
  const timer = setTimeout(() => die(`timed out waiting for evaluate #${id}`), 30000);
  pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
  ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
});

const script = (tab) => `(async () => {
  const view = app.workspace.getLeavesOfType('pm-compass-dashboard')[0].view;
  view.activeTab = ${JSON.stringify(tab)};
  await view.render();
  const copy = document.querySelector('.pm-dash-content').cloneNode(true);

  const TASKS = [
    'Draft the scoping note', 'Review the supplier quote', 'Prepare Friday\'s demo',
    'Sort the weekend photos', 'Call the garage', 'Split the budget into lots',
    'Write the parser tests', 'Tidy the workshop', 'Answer the call for tenders',
    'Plan the summer leave', 'Update the schema', 'Order the spare parts',
  ];
  const PROJECTS = ['Project Alpha', 'Project Bravo', 'House', 'Tech watch'];
  const HABITS = [
    'Walk 30 minutes', 'Read 10 pages', 'Review the day', 'Stretching',
    'Drink 1.5 L', 'Evening journal', 'Tidy the desk', 'Five minutes of quiet',
  ];

  let t = 0, p = 0, h = 0;
  copy.querySelectorAll('.pm-dash-item-text').forEach((el) => { el.textContent = HABITS[h++ % HABITS.length]; });
  copy.querySelectorAll('.pm-dash-checklist-text, .pm-inbox-title, .pm-dash-task-title, .pm-tm-row-label')
    .forEach((el) => {
      const habit = el.closest('.pm-day-task-row')?.querySelector('.pm-dash-checklist-daily-icon');
      el.textContent = habit ? HABITS[h++ % HABITS.length] : TASKS[t++ % TASKS.length];
    });
  copy.querySelectorAll('.pm-dash-task-project, .pm-dash-habit-name, .pm-dash-stat-task')
    .forEach((el) => { el.textContent = PROJECTS[p++ % PROJECTS.length]; });
  copy.querySelectorAll('.pm-inbox-file-name').forEach((el) => { el.textContent = 'Inbox.md'; });
  // Tooltips and labels quote the vault's own words back — a project's name is on its icon,
  // a day's date on its badge. None of it is visible in a screenshot, so drop the lot rather
  // than keep a list of which are safe.
  copy.querySelectorAll('[title], [aria-label]').forEach((el) => {
    el.removeAttribute('title');
    el.removeAttribute('aria-label');
  });
  // Note panels hold free text; the preview only needs to show that the row can carry one.
  copy.querySelectorAll('.pm-day-task-note-line').forEach((el) => { el.textContent = 'A note attached to the task.'; });
  return copy.innerHTML;
})()`;

const out = {};
for (const tab of ["tasks", "inbox", "stats"]) {
  const msg = await evaluate(script(tab));
  const value = msg.result?.result?.value;
  if (typeof value !== "string") { console.error(tab, JSON.stringify(msg.result)); process.exit(1); }
  out[tab] = value;
  console.error(`${tab}: ${value.length} chars`);
}
// A script rather than JSON: `tabs.html` can then be opened straight from the file system,
// with no fetch and so no origin rules to work around.
writeFileSync(new URL("./tabs.js", import.meta.url), `window.TABS = ${JSON.stringify(out)};\n`);
process.exit(0);
