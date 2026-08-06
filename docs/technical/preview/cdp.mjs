// Evaluate an expression in Obsidian's WebView over CDP. Usage: node cdp.mjs '<js>'
const targets = await (await fetch("http://localhost:9222/json/list")).json();
const page = targets.find((t) => t.type === "page" && t.url.startsWith("http://localhost"));
if (!page) { console.error("no page target"); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
const expression = process.argv[2];

await new Promise((r) => ws.addEventListener("open", r));
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id !== 1) return;
  const res = msg.result?.result;
  console.log(res?.value !== undefined ? res.value : JSON.stringify(msg.result));
  ws.close();
  process.exit(0);
});
ws.send(JSON.stringify({
  id: 1,
  method: "Runtime.evaluate",
  params: { expression, awaitPromise: true, returnByValue: true },
}));
setTimeout(() => { console.error("timeout"); process.exit(1); }, 15000);
