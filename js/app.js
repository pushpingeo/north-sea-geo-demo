import { CONFIG } from "./config.js";
import { callClaude, liveMode, LimitReached, getUserKey, setUserKey } from "./claude.js";
import { summariseForClaude, bbox } from "./results.js";
import { stripFences } from "./engines/util.js";
import { turfEngine } from "./engines/turf.js";
import { duckdbEngine } from "./engines/duckdb.js";
import { geopandasEngine } from "./engines/geopandas.js";
import { EXAMPLES } from "./examples.js";

const ENGINES = { turf: turfEngine, duckdb: duckdbEngine, geopandas: geopandasEngine };
const $ = (s) => document.querySelector(s);

const state = {
  manifest: [],
  layers: {}, // id -> FeatureCollection
  schema: "",
  engine: "turf",
  ready: {}, // engine id -> Promise
  history: [],
  busy: false,
  forcedOffline: false,
};

// ---------- map ----------

const map = new maplibregl.Map({
  container: "map",
  style: CONFIG.basemapStyle,
  center: CONFIG.mapStart.center,
  zoom: CONFIG.mapStart.zoom,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
const mapLoaded = new Promise((r) => map.on("load", r));

function addDataLayers() {
  for (const L of state.manifest) {
    const fc = state.layers[L.id];
    map.addSource(L.id, { type: "geojson", data: fc });
    const g = geomFamily(fc);
    if (g === "polygon") {
      map.addLayer({ id: `${L.id}-fill`, type: "fill", source: L.id,
        paint: { "fill-color": L.color, "fill-opacity": 0.12 } });
      map.addLayer({ id: `${L.id}-line`, type: "line", source: L.id,
        paint: { "line-color": L.color, "line-width": 0.8, "line-opacity": 0.7 } });
    } else if (g === "line") {
      map.addLayer({ id: `${L.id}-line`, type: "line", source: L.id,
        paint: { "line-color": L.color, "line-width": 1.2, "line-opacity": 0.75 } });
    } else {
      map.addLayer({ id: `${L.id}-pt`, type: "circle", source: L.id,
        paint: {
          "circle-color": L.color,
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 1.4, 9, 4],
          "circle-opacity": 0.7,
        } });
    }
    L.mapLayers = map.getStyle().layers.filter((x) => x.source === L.id).map((x) => x.id);
    if (L.hidden) L.mapLayers.forEach((id) => map.setLayoutProperty(id, "visibility", "none"));
    for (const id of L.mapLayers) {
      map.on("click", id, (e) => popup(e, L.name));
      map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
    }
  }

  map.addSource("result", { type: "geojson", data: empty() });
  map.addLayer({ id: "result-fill", type: "fill", source: "result",
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: { "fill-color": "#e8590c", "fill-opacity": 0.3 } });
  map.addLayer({ id: "result-line", type: "line", source: "result",
    filter: ["!=", ["geometry-type"], "Point"],
    paint: { "line-color": "#e8590c", "line-width": 2.5 } });
  map.addLayer({ id: "result-pt", type: "circle", source: "result",
    filter: ["==", ["geometry-type"], "Point"],
    paint: { "circle-color": "#e8590c", "circle-radius": 5,
      "circle-stroke-color": "#fff", "circle-stroke-width": 1.2 } });
  for (const id of ["result-fill", "result-line", "result-pt"]) {
    map.on("click", id, (e) => popup(e, "Result"));
  }
}

function popup(e, title) {
  const f = e.features[0];
  const rows = Object.entries(f.properties || {})
    .slice(0, 12)
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(String(v))}</td></tr>`)
    .join("");
  new maplibregl.Popup({ maxWidth: "300px" })
    .setLngLat(e.lngLat)
    .setHTML(`<strong>${esc(title)}</strong><table class="pop">${rows}</table>`)
    .addTo(map);
}

function showResult(fc) {
  map.getSource("result").setData(fc);
  const b = bbox(fc);
  if (b) map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 60, maxZoom: 10, duration: 900 });
}

const empty = () => ({ type: "FeatureCollection", features: [] });

function geomFamily(fc) {
  const t = (fc.features.find((f) => f.geometry) || {}).geometry?.type || "Point";
  if (t.includes("Polygon")) return "polygon";
  if (t.includes("Line")) return "line";
  return "point";
}

function buildLegend() {
  const el = $("#legend .items");
  if (matchMedia("(max-width: 820px)").matches) $("#legend").open = false;
  el.innerHTML = state.manifest
    .map((L) => `<label><input type="checkbox" data-id="${L.id}" ${L.hidden ? "" : "checked"}>
      <span class="sw sw-${geomFamily(state.layers[L.id])}" style="--c:${L.color}"></span>
      ${esc(L.name)} <small>${state.layers[L.id].features.length.toLocaleString()}</small></label>`)
    .join("");
  el.addEventListener("change", (e) => {
    const L = state.manifest.find((x) => x.id === e.target.dataset.id);
    L.mapLayers.forEach((id) =>
      map.setLayoutProperty(id, "visibility", e.target.checked ? "visible" : "none"));
  });
}

// ---------- data ----------

async function loadData() {
  state.manifest = await (await fetch("data/layers.json")).json();
  await Promise.all(
    state.manifest.map(async (L) => {
      state.layers[L.id] = await (await fetch(`data/${L.file}`)).json();
    })
  );
  state.schema = describeLayers();
}

function describeLayers() {
  return state.manifest
    .map((L) => {
      const fc = state.layers[L.id];
      const fields = {};
      for (const f of fc.features) {
        for (const [k, v] of Object.entries(f.properties || {})) {
          if (v == null || v === "") continue;
          const s = (fields[k] ||= { type: typeof v, vals: new Set(), min: Infinity, max: -Infinity });
          if (typeof v === "number") {
            s.min = Math.min(s.min, v);
            s.max = Math.max(s.max, v);
          } else if (s.vals.size < 40) s.vals.add(String(v));
        }
      }
      const lines = Object.entries(fields).map(([k, s]) => {
        if (s.type === "number") return `  - ${k} (number, ${s.min} to ${s.max})`;
        const vals = [...s.vals];
        const few = vals.length < 12 ? `values: ${vals.join(" | ")}` : `e.g. ${vals.slice(0, 4).join(" | ")}`;
        return `  - ${k} (text; ${few})`;
      });
      const types = {};
      for (const f of fc.features) if (f.geometry) types[f.geometry.type] = (types[f.geometry.type] || 0) + 1;
      const g = Object.entries(types).map(([t, n]) => `${n} ${t}`).join(" + ");
      return `Layer "${L.id}" - ${L.name}: ${fc.features.length} features (${g}). ${L.description || ""}
${lines.join("\n")}`;
    })
    .join("\n\n");
}

// ---------- engines ----------

function ensureEngine(id) {
  if (!state.ready[id]) {
    const eng = ENGINES[id];
    setStatus(id, "loading", `Loading ${eng.label}...`);
    state.ready[id] = eng
      .load(state.layers, (msg) => setStatus(id, "loading", msg))
      .then(() => setStatus(id, "ready", `${eng.label} ready`))
      .catch((e) => {
        delete state.ready[id];
        setStatus(id, "error", `${eng.label} failed to load: ${e.message}`);
        throw e;
      });
  }
  return state.ready[id];
}

function setStatus(id, kind, text) {
  if (id !== state.engine) return;
  const el = $("#engine-status");
  el.className = `status ${kind}`;
  el.textContent = text;
}

async function runCode(code) {
  const eng = ENGINES[state.engine];
  if (eng.dead) {
    eng.dead = false;
    delete state.ready[state.engine];
  }
  await ensureEngine(state.engine);
  const t0 = performance.now();
  const res = await eng.run(stripFences(code));
  return { res, ms: performance.now() - t0 };
}

// ---------- Claude ----------

const TOOL = {
  name: "run_analysis",
  description:
    "Run code in the currently selected geospatial engine against the map layers. " +
    "Geometry results are drawn on the map; other results come back as a table or value.",
  input_schema: {
    type: "object",
    properties: {
      code: { type: "string", description: "Code in the current engine's language only." },
      title: { type: "string", description: 'Short label for the result, e.g. "Wells within 10 km of the pipeline".' },
    },
    required: ["code", "title"],
  },
};

function systemPrompt() {
  const eng = ENGINES[state.engine];
  return `You are the analysis assistant in a public demo: a map of UK North Sea energy infrastructure with a chat beside it.
The demo's point: the AI is the interface, and the analysis engine underneath is swappable. The visitor chooses the engine; you write the code for it.

CURRENT ENGINE: ${eng.label} (${eng.language}). Earlier turns may have used another engine. Always write code for the current one.
${eng.guide}

DATA ON THE MAP
${state.schema}

HOW TO WORK
- Use run_analysis for anything that needs the data. Never guess counts, distances or names.
- Text values are mostly UPPER CASE in the source data. Match names case-insensitively and allow partial matches (e.g. "Forties" should find "FORTIES").
- If the code errors, read the error, fix it and try again (three tries at most).
- If a question can't be answered from these layers, say so plainly and suggest one that can.
- The final answer: two to four plain sentences with the key numbers. If something was drawn on the map, say what the orange features are.
- No markdown headings or tables in the answer. The visitor can open your code underneath it.
- Data is public open data (NSTA and The Crown Estate / Crown Estate Scotland), simplified for the demo. It may be out of date.`;
}

function trimHistory() {
  // Keep the last few turns. Cut only at a plain user question so tool pairs stay intact.
  while (state.history.length > 24) {
    const i = state.history.findIndex(
      (m, idx) => idx > 0 && m.role === "user" && typeof m.content === "string"
    );
    if (i <= 0) break;
    state.history = state.history.slice(i);
  }
}

// Claude's thinking blocks are signed against the system prompt they were written
// under, and the system prompt changes when the engine does. Earlier turns don't
// need their thinking, so drop it before each new question. Thinking inside the
// current question's tool loop is kept, as the API requires.
function dropOldThinking() {
  state.history = state.history.map((m) => {
    if (m.role !== "assistant" || !Array.isArray(m.content)) return m;
    const content = m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
    return { ...m, content: content.length ? content : [{ type: "text", text: "(no reply)" }] };
  });
}

async function askClaude(question) {
  dropOldThinking();
  state.history.push({ role: "user", content: question });
  trimHistory();
  const thinking = addThinking();
  try {
    for (let round = 0; round < CONFIG.maxToolRounds; round++) {
      const resp = await callClaude({ system: systemPrompt(), messages: state.history, tools: [TOOL] });
      state.history.push({ role: "assistant", content: resp.content });

      for (const b of resp.content) if (b.type === "text" && b.text.trim()) addAssistantText(b.text);
      const uses = resp.content.filter((b) => b.type === "tool_use");
      if (resp.stop_reason !== "tool_use" || !uses.length) break;

      const results = [];
      for (const u of uses) {
        const card = addCodeCard(u.input.title, u.input.code, ENGINES[state.engine]);
        try {
          const { res, ms } = await runCode(u.input.code);
          fillCard(card, res, ms);
          if (res.kind === "features") showResult(res.geojson);
          results.push({ type: "tool_result", tool_use_id: u.id,
            content: JSON.stringify(summariseForClaude(res, ms)) });
        } catch (e) {
          failCard(card, e);
          results.push({ type: "tool_result", tool_use_id: u.id, is_error: true,
            content: String(e.message || e).slice(0, 1500) });
        }
      }
      state.history.push({ role: "user", content: results });
    }
  } catch (e) {
    // Leave history ending on a user question; drop it so the next turn starts clean.
    while (state.history.length && state.history.at(-1).role === "user") state.history.pop();
    if (e instanceof LimitReached) {
      state.forcedOffline = true;
      updateMode();
      addNote(`${e.message} You can still run the example questions below, or add your own API key.`);
    } else {
      addNote(`Something went wrong talking to Claude: ${e.message}`);
    }
  } finally {
    thinking.remove();
  }
}

async function runExample(ex) {
  addUser(ex.question);
  const code = ex.code[state.engine];
  const card = addCodeCard(ex.title, code, ENGINES[state.engine], true);
  try {
    const { res, ms } = await runCode(code);
    fillCard(card, res, ms);
    if (res.kind === "features") showResult(res.geojson);
    if (ex.answer) addAssistantText(ex.answer(res), true);
  } catch (e) {
    failCard(card, e);
  }
}

// ---------- chat UI ----------

const log = $("#log");
const scroll = () => (log.scrollTop = log.scrollHeight);

function addUser(text) {
  const d = document.createElement("div");
  d.className = "msg user";
  d.textContent = text;
  log.appendChild(d);
  scroll();
}

function addAssistantText(text, offline = false) {
  const d = document.createElement("div");
  d.className = "msg bot" + (offline ? " offline" : "");
  d.innerHTML = md(text);
  log.appendChild(d);
  scroll();
}

function addNote(text) {
  const d = document.createElement("div");
  d.className = "note";
  d.textContent = text;
  log.appendChild(d);
  scroll();
}

function addThinking() {
  const d = document.createElement("div");
  d.className = "thinking";
  d.innerHTML = "<span></span><span></span><span></span>";
  log.appendChild(d);
  scroll();
  return d;
}

function addCodeCard(title, code, eng, prewritten = false) {
  const d = document.createElement("div");
  d.className = `card eng-${eng.id}`;
  const lines = code.trim().split("\n").length;
  d.innerHTML = `
    <div class="card-head">
      <span class="badge">${esc(eng.label)}</span>
      <span class="card-title">${esc(title || "Analysis")}</span>
      <span class="card-meta">running...</span>
    </div>
    <details>
      <summary>${prewritten ? "Pre-written" : "Claude's"} ${esc(eng.language)} &middot; ${lines} line${lines === 1 ? "" : "s"}</summary>
      <pre><code>${esc(code.trim())}</code></pre>
    </details>
    <div class="card-out"></div>`;
  log.appendChild(d);
  scroll();
  return d;
}

function fillCard(card, res, ms) {
  const meta = card.querySelector(".card-meta");
  const what =
    res.kind === "features" ? `${res.count} feature${res.count === 1 ? "" : "s"} on map`
      : res.kind === "table" ? `${res.count} row${res.count === 1 ? "" : "s"}`
      : "value";
  meta.textContent = `${fmtMs(ms)} · ${what}`;
  const out = card.querySelector(".card-out");
  if (res.kind === "table") out.innerHTML = table(res.rows);
  else if (res.kind === "value") out.innerHTML = `<div class="value">${esc(fmtVal(res.value))}</div>`;
  scroll();
}

function failCard(card, e) {
  card.classList.add("failed");
  card.querySelector(".card-meta").textContent = "error";
  card.querySelector(".card-out").innerHTML = `<pre class="err">${esc(String(e.message || e))}</pre>`;
  scroll();
}

function table(rows) {
  if (!rows.length) return `<div class="value">No rows</div>`;
  const cols = Object.keys(rows[0]).slice(0, 6);
  const body = rows.slice(0, 8)
    .map((r) => `<tr>${cols.map((c) => `<td>${esc(fmtVal(r[c]))}</td>`).join("")}</tr>`)
    .join("");
  const more = rows.length > 8 ? `<div class="more">+ ${rows.length - 8} more</div>` : "";
  return `<div class="tbl"><table><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>${body}</table></div>${more}`;
}

const fmtMs = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
function fmtVal(v) {
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (v && typeof v === "object") return JSON.stringify(v);
  return v == null ? "" : String(v);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function md(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// ---------- controls ----------

function updateMode() {
  const mode = state.forcedOffline && liveMode() === "proxy" ? "offline" : liveMode();
  state.mode = mode;
  const pill = $("#mode");
  pill.className = `mode ${mode}`;
  pill.textContent = mode === "offline" ? "Examples only" : "Live · Claude";
  $("#input").disabled = mode === "offline";
  $("#input").placeholder =
    mode === "offline"
      ? "Live chat is off. Try an example below, or add your own key (⚙)."
      : "Ask about the wells, pipelines, licences or wind farms...";
  $("#send").disabled = mode === "offline";
}

function buildExamples() {
  const el = $("#examples");
  el.innerHTML = EXAMPLES.map((ex, i) => `<button data-i="${i}">${esc(ex.question)}</button>`).join("");
  el.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b || state.busy) return;
    const ex = EXAMPLES[+b.dataset.i];
    await busy(() => (state.mode === "offline" ? runExample(ex) : (addUser(ex.question), askClaude(ex.question))));
  });
}

async function busy(fn) {
  state.busy = true;
  document.body.classList.add("busy");
  $("#engine").disabled = true; // the engine can't change halfway through an answer
  try {
    await fn();
  } finally {
    state.busy = false;
    document.body.classList.remove("busy");
    $("#engine").disabled = false;
  }
}

function buildEngineSelect() {
  const sel = $("#engine");
  sel.innerHTML = Object.values(ENGINES)
    .map((e) => `<option value="${e.id}">${esc(e.label)}</option>`)
    .join("");
  sel.value = state.engine;
  $("#engine-blurb").textContent = ENGINES[state.engine].blurb;
  sel.addEventListener("change", () => {
    state.engine = sel.value;
    $("#engine-blurb").textContent = ENGINES[state.engine].blurb;
    addNote(`Engine switched to ${ENGINES[state.engine].label}. Same questions, different tool underneath.`);
    ensureEngine(state.engine).catch(() => {});
    if (state.ready[state.engine]) {
      state.ready[state.engine].then(() => setStatus(state.engine, "ready", `${ENGINES[state.engine].label} ready`), () => {});
    }
  });
}

function wireInput() {
  const form = $("#ask");
  const input = $("#input");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q || state.busy || state.mode === "offline") return;
    input.value = "";
    addUser(q);
    await busy(() => askClaude(q));
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  $("#clear").addEventListener("click", () => {
    state.history = [];
    log.innerHTML = "";
    map.getSource("result")?.setData(empty());
    intro();
  });

  const dlg = $("#settings");
  $("#gear").addEventListener("click", () => {
    $("#key").value = getUserKey();
    dlg.showModal();
  });
  $("#key-save").addEventListener("click", () => {
    setUserKey($("#key").value.trim());
    state.forcedOffline = false;
    updateMode();
  });
  $("#key-clear").addEventListener("click", () => {
    setUserKey("");
    $("#key").value = "";
    updateMode();
  });
}

function intro() {
  addAssistantText(
    `Ask a question about the North Sea data on the map. I'll write the analysis in whichever engine you pick at the top, run it in your browser, and show you the code.

Swap the engine and ask the same thing again. The code changes completely; the answer shouldn't.`
  );
}

// ---------- start ----------

(async function start() {
  $("#author").innerHTML = `<a href="${CONFIG.author.url}" target="_blank" rel="noopener">${esc(CONFIG.author.name)}</a>`;
  buildEngineSelect();
  wireInput();
  updateMode();
  intro();
  try {
    await loadData();
  } catch (e) {
    addNote(`Couldn't load the map data: ${e.message}`);
    return;
  }
  buildExamples();
  await mapLoaded;
  addDataLayers();
  buildLegend();
  ensureEngine(state.engine).catch(() => {});
})();
