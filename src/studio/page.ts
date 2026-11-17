/**
 * The studio's single page: markup, styles and script in one string, with no build step and no
 * dependencies. It talks only to the API in `api.ts`, sending the session token it was served with.
 * Everything it shows comes from the prompt files, so it never holds state of its own to go stale.
 */
export function studioPage(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trace and Scale Studio</title>
<style>
  :root { --bg:#f6f7f9; --panel:#fff; --ink:#101828; --muted:#5b6577; --line:#e3e7ee; --accent:#0e9f8e; --accent-ink:#fff;
          --error:#b42318; --error-bg:#fef3f2; --warn:#b54708; --warn-bg:#fffaeb; --info:#175cd3; --info-bg:#eff8ff; --code:#0f1722; --code-ink:#dbe4f0; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b1220; --panel:#111a2b; --ink:#e7edf6; --muted:#93a2b8; --line:#22304a;
          --error:#fda29b; --error-bg:#3a1512; --warn:#fec84b; --warn-bg:#3a2a08; --info:#84caff; --info-bg:#0f2a47; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.45 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif; height:100vh; display:grid; grid-template-rows:auto 1fr; }
  header { display:flex; gap:12px; align-items:center; padding:10px 16px; background:var(--panel); border-bottom:1px solid var(--line); }
  header h1 { font-size:15px; margin:0; } header .meta { color:var(--muted); font-size:12px; }
  .pill { font-size:11px; padding:2px 8px; border-radius:999px; border:1px solid var(--line); color:var(--muted); white-space:nowrap; }
  main { display:grid; grid-template-columns:260px minmax(0,1fr) 360px; min-height:0; }
  aside, section { min-height:0; overflow:auto; }
  #list { background:var(--panel); border-right:1px solid var(--line); padding:10px; }
  #list input { width:100%; padding:7px 9px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--ink); margin-bottom:8px; }
  .item { display:flex; align-items:center; gap:8px; padding:7px 8px; border-radius:6px; cursor:pointer; }
  .item:hover { background:var(--bg); } .item.active { background:var(--bg); outline:1px solid var(--accent); }
  .item .name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .item.archived .name { text-decoration:line-through; color:var(--muted); }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--accent); flex:none; } .dot.warning { background:#f79009; } .dot.error { background:#d92d20; }
  #editor { display:grid; grid-template-rows:auto 1fr auto; padding:12px; gap:8px; }
  .bar { display:flex; gap:8px; align-items:center; } .bar .title { font-weight:600; flex:1; overflow:hidden; text-overflow:ellipsis; }
  textarea { width:100%; height:100%; resize:none; border:1px solid var(--line); border-radius:8px; padding:12px; background:var(--code); color:var(--code-ink);
             font:13px/1.5 "SF Mono",Menlo,Consolas,monospace; tab-size:2; }
  button { font:inherit; padding:6px 12px; border-radius:6px; border:1px solid var(--line); background:var(--panel); color:var(--ink); cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:var(--accent-ink); } button:disabled { opacity:.5; cursor:default; }
  #side { border-left:1px solid var(--line); background:var(--panel); padding:12px; }
  h2 { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin:16px 0 6px; } h2:first-child { margin-top:0; }
  .note { border-radius:6px; padding:7px 9px; margin-bottom:6px; font-size:12.5px; }
  .note.error { background:var(--error-bg); color:var(--error); } .note.warning { background:var(--warn-bg); color:var(--warn); } .note.info { background:var(--info-bg); color:var(--info); }
  .note b { text-transform:capitalize; }
  .chips { display:flex; flex-wrap:wrap; gap:6px; } .chip { font:12px "SF Mono",Menlo,monospace; padding:2px 7px; border-radius:5px; background:var(--bg); border:1px solid var(--line); }
  .field { display:grid; gap:3px; margin-bottom:6px; } .field label { font-size:12px; color:var(--muted); }
  .field input { padding:6px 8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--ink); font:12.5px "SF Mono",Menlo,monospace; }
  pre.out { background:var(--code); color:var(--code-ink); border-radius:6px; padding:9px; font:12px/1.5 "SF Mono",Menlo,monospace; white-space:pre-wrap; word-break:break-word; margin:6px 0 0; max-height:260px; overflow:auto; }
  .empty { color:var(--muted); padding:30px; text-align:center; } .muted { color:var(--muted); font-size:12.5px; } .row { display:flex; gap:6px; flex-wrap:wrap; }
  @media (max-width: 980px) { main { grid-template-columns:200px minmax(0,1fr); } #side { grid-column:1 / -1; border-left:0; border-top:1px solid var(--line); } }
</style>
</head>
<body>
<header>
  <h1>Trace and Scale Studio</h1>
  <span class="pill" id="platform"></span><span class="pill" id="canonical"></span>
  <span class="meta" id="dir"></span>
</header>
<main>
  <aside id="list">
    <input id="filter" placeholder="Filter prompts" aria-label="Filter prompts">
    <div id="items"></div>
    <div class="row" style="margin-top:10px"><button id="new-chat">New chat prompt</button><button id="new-text">New text prompt</button></div>
  </aside>
  <section id="editor">
    <div class="bar"><span class="title" id="title">Select a prompt</span><span class="pill" id="state" hidden></span><span class="muted" id="dirty"></span>
      <button id="save" class="primary" disabled>Save</button></div>
    <textarea id="source" spellcheck="false" aria-label="Prompt YAML" disabled></textarea>
    <div class="muted" id="hint">Edits are written to the prompt file when you save. Cmd/Ctrl+S saves.</div>
  </section>
  <aside id="side"><div class="empty">Pick a prompt on the left, or create one.</div></aside>
</main>
<script>
const TOKEN = ${JSON.stringify(token)};
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; };
let info = {}, prompts = [], states = {}, current = null, saved = "", detail = null, timer;

async function api(method, path, body) {
  const response = await fetch(path, { method, headers: { "content-type": "application/json", "x-tas-token": TOKEN }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || response.statusText), { issues: data.issues });
  return data;
}

function renderList() {
  const filter = $("filter").value.toLowerCase();
  $("items").replaceChildren(...prompts.filter((p) => p.name.includes(filter)).map((p) => {
    const item = el("div", { className: "item" + (p.name === current ? " active" : "") + (p.archived ? " archived" : ""), title: p.description || p.name },
      el("span", { className: "dot " + (p.valid ? p.level : "error") }), el("span", { className: "name", textContent: p.name }));
    if (states[p.name] && states[p.name] !== "in-sync") item.append(el("span", { className: "pill", textContent: states[p.name] }));
    item.onclick = () => open(p.name);
    return item;
  }));
  if (!prompts.length) $("items").append(el("div", { className: "muted", textContent: "No prompts yet." }));
}

function section(title, ...children) { return [el("h2", { textContent: title }), ...children]; }
function chips(values, empty) { return values.length ? el("div", { className: "chips" }, ...values.map((v) => el("span", { className: "chip", textContent: v }))) : el("div", { className: "muted", textContent: empty }); }

function renderSide() {
  if (!detail) return;
  const side = $("side"), parts = [];
  if (detail.issues.length) parts.push(...section("Not valid", ...detail.issues.map((i) => el("div", { className: "note error", textContent: i }))));
  parts.push(...section("Variables", chips(detail.variables, "None")));
  if (detail.placeholders.length) parts.push(...section("Placeholders", chips(detail.placeholders, "")));
  parts.push(...section("Across platforms", ...(detail.notes.length
    ? detail.notes.map((n) => el("div", { className: "note " + n.level }, el("b", { textContent: (n.platform === "all" ? "every platform" : n.platform) + ": " }), n.message))
    : [el("div", { className: "muted", textContent: detail.definition ? "Stored natively on Braintrust, Langfuse and LangSmith." : "Fix the prompt to see this." })])));

  if (info.canSync) {
    const out = el("pre", { className: "out", hidden: true });
    const act = (label, path, force) => { const b = el("button", { textContent: label }); b.onclick = async () => {
      out.hidden = false; out.textContent = "Working…";
      try { const results = await api("POST", path, { names: [current], force });
        out.textContent = results.map((r) => r.action + (r.version ? " @" + r.version : "") + (r.reason ? " (" + r.reason + ")" : "") + (r.overwrote ? " (overwrote " + r.overwrote + " change)" : "")).join("\\n") || "nothing to do";
        await Promise.all([refreshStatus(), open(current, true)]);
      } catch (error) { out.textContent = error.message; } }; return b; };
    parts.push(...section("Sync with " + info.platform, el("div", { className: "row" }, act("Push", "/api/push", false), act("Pull", "/api/pull", false), act("Force push", "/api/push", true)), out));
  }

  const inputs = detail.variables.map((v) => el("div", { className: "field" }, el("label", { textContent: v }), el("input", { name: v, placeholder: "value for {{" + v + "}}" })));
  const preview = el("pre", { className: "out", hidden: true });
  const values = () => { const vars = {}; for (const input of side.querySelectorAll(".field input")) { let node = vars; const path = input.name.split(".");
    path.slice(0, -1).forEach((k) => (node = node[k] ??= {})); node[path.at(-1)] = input.value; } return vars; };
  const run = (label, path, format) => { const b = el("button", { textContent: label }); b.onclick = async () => { preview.hidden = false; preview.textContent = "Working…";
    try { preview.textContent = format(await api("POST", path, { name: current, source: $("source").value, variables: values() })); } catch (error) { preview.textContent = error.message; } }; return b; };
  const asText = (content) => typeof content === "string" ? content : content.map((p) => p.type === "text" ? p.text : "[" + p.type + ": " + p.url + "]").join("\\n");
  parts.push(...section("Try it", ...inputs, el("div", { className: "row" },
    run("Preview messages", "/api/render", (r) => r.messages.map((m) => m.role.toUpperCase() + "\\n" + asText(m.content)).join("\\n\\n")),
    ...(info.canRun ? [run("Run saved version", "/api/run", (r) => r.text + "\\n\\n— " + r.model + ", " + r.usage.totalTokens + " tokens")] : [])), preview));
  if (info.canRun) parts.push(el("div", { className: "muted", style: "margin-top:6px", textContent: "Run makes a real model call through your gateway, using the saved file." }));
  side.replaceChildren(...parts);
}

function setDirty() { const dirty = $("source").value !== saved; $("dirty").textContent = dirty ? "unsaved changes" : ""; $("save").disabled = !dirty || !detail || !detail.definition; }

async function open(name, keepText) {
  if (!keepText && current && $("source").value !== saved && !confirm("Discard unsaved changes to " + current + "?")) return;
  current = name; detail = await api("GET", "/api/prompts/" + encodeURIComponent(name)); saved = detail.source;
  $("title").textContent = name; $("source").value = detail.source; $("source").disabled = false;
  $("state").hidden = !states[name]; $("state").textContent = states[name] || "";
  setDirty(); renderList(); renderSide();
}

async function refresh() { prompts = await api("GET", "/api/prompts"); renderList(); }
async function refreshStatus() { if (!info.canSync) return; try { states = Object.fromEntries((await api("GET", "/api/status")).map((s) => [s.name, s.state])); } catch { states = {}; }
  renderList(); if (current) { $("state").hidden = !states[current]; $("state").textContent = states[current] || ""; } }

async function save() {
  try { detail = await api("PUT", "/api/prompts/" + encodeURIComponent(current), { source: $("source").value }); saved = detail.source; $("source").value = detail.source;
    setDirty(); renderSide(); await refresh(); refreshStatus(); } catch (error) { alert(error.message + (error.issues ? "\\n\\n" + error.issues.join("\\n") : "")); }
}
async function create(type) {
  const name = prompt("Name for the new " + type + " prompt, e.g. support/triage"); if (!name) return;
  try { await api("POST", "/api/prompts", { name, type }); await refresh(); await open(name, true); } catch (error) { alert(error.message); }
}

$("source").addEventListener("input", () => { setDirty(); clearTimeout(timer); timer = setTimeout(async () => {
  detail = await api("POST", "/api/check", { name: current, source: $("source").value }); setDirty(); renderSide(); }, 250); });
$("source").addEventListener("keydown", (event) => { if (event.key === "Tab") { event.preventDefault(); document.execCommand("insertText", false, "  "); } });
document.addEventListener("keydown", (event) => { if ((event.metaKey || event.ctrlKey) && event.key === "s") { event.preventDefault(); if (!$("save").disabled) save(); } });
$("save").onclick = save; $("filter").oninput = renderList; $("new-chat").onclick = () => create("chat"); $("new-text").onclick = () => create("text");
window.addEventListener("beforeunload", (event) => { if ($("source").value !== saved) event.preventDefault(); });

(async () => {
  info = await api("GET", "/api/info");
  $("platform").textContent = info.platform; $("canonical").textContent = info.canonical + " is canonical"; $("dir").textContent = info.promptsDir;
  await refresh(); refreshStatus();
})();
</script>
</body>
</html>`;
}
