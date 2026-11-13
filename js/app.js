import { CONFIG } from "./config.js";
import { callClaude, liveMode, LimitReached, getUserKey, setUserKey } from "./claude.js";
import { summariseForClaude, bbox } from "./results.js";
import { stripFences } from "./engines/util.js";
import { turfEngine } from "./engines/turf.js";
import { duckdbEngine } from "./engines/duckdb.js";
import { geopandasEngine } from "./engines/geopandas.js";
import { compareResults } from "./compare.js";
import { EXAMPLES } from "./examples.js";

const ENGINES = { turf: turfEngine, duckdb: duckdbEngine, geopandas: geopandasEngine };
const IDS = Object.keys(ENGINES);
const LABELS = Object.fromEntries(IDS.map((id) => [id, ENGINES[id].label]));
const COLORS = { turf: "#2b8a3e", duckdb: "#d08c00", geopandas: "#1c64c4" };
const $ = (s) => document.querySelector(s);

const state = {
  manifest: [],
  layers: {},
  schema: "",
  ready: {}, // engine id -> Promise
  engineStatus: {}, // engine id -> { kind, text }
  specHistory: [],
  threads: Object.fromEntries(IDS.map((id) => [id, { history: [], result: null, phase: "idle" }])),
  tab: "turf",
  busy: false,
  forcedOffline: false,
  mode: "offline",
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

const POLY = ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false];
const POINT = ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false];
const NOT_POINT = ["match", ["geometry-type"], ["Point", "MultiPoint"], false, true];

function addDataLayers() {
  for (const L of state.manifest) {
    const fc = state.layers[L.id];
    map.addSource(L.id, { type: "geojson", data: fc });
    const g = geomFamily(fc);
    if (g === "polygon") {
      map.addLayer({ id: `${L.id}-fill`, type: "fill", source: L.id, paint: { "fill-color": L.color, "fill-opacity": 0.1 } });
      map.addLayer({ id: `${L.id}-line`, type: "line", source: L.id, paint: { "line-color": L.color, "line-width": 0.8, "line-opacity": 0.6 } });
    } else if (g === "line") {
      map.addLayer({ id: `${L.id}-line`, type: "line", source: L.id, paint: { "line-color": L.color, "line-width": 1.1, "line-opacity": 0.6 } });
    } else {
      map.addLayer({ id: `${L.id}-pt`, type: "circle", source: L.id, paint: {
        "circle-color": L.color, "circle-opacity": 0.55,
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 1.3, 9, 4] } });
    }
    L.mapLayers = map.getStyle().layers.filter((x) => x.source === L.id).map((x) => x.id);
    if (L.hidden) L.mapLayers.forEach((id) => map.setLayoutProperty(id, "visibility", "none"));
    for (const id of L.mapLayers) {
      map.on("click", id, (e) => popup(e, L.name));
      hoverCursor(id);
    }
  }

  // Disagreements first so the engine results draw on top of the red halo.
  map.addSource("res-diff", { type: "geojson", data: empty() });
  map.addLayer({ id: "res-diff-fill", type: "fill", source: "res-diff", filter: POLY, paint: { "fill-color": "#e03131", "fill-opacity": 0.25 } });
  map.addLayer({ id: "res-diff-line", type: "line", source: "res-diff", filter: NOT_POINT, paint: { "line-color": "#e03131", "line-width": 7, "line-opacity": 0.45 } });
  map.addLayer({ id: "res-diff-pt", type: "circle", source: "res-diff", filter: POINT, paint: { "circle-radius": 13, "circle-color": "#e03131", "circle-opacity": 0.3 } });
  map.on("click", "res-diff-pt", (e) => popup(e, "Not found by every engine"));
  map.on("click", "res-diff-fill", (e) => popup(e, "Not found by every engine"));

  for (const id of IDS) {
    map.addSource(`res-${id}`, { type: "geojson", data: empty() });
    map.addLayer({ id: `res-${id}-fill`, type: "fill", source: `res-${id}`, filter: POLY, paint: { "fill-color": COLORS[id], "fill-opacity": 0.3 } });
    map.addLayer({ id: `res-${id}-line`, type: "line", source: `res-${id}`, filter: NOT_POINT, paint: { "line-color": COLORS[id], "line-width": 2.5 } });
    map.addLayer({ id: `res-${id}-pt`, type: "circle", source: `res-${id}`, filter: POINT, paint: {
      "circle-color": COLORS[id], "circle-radius": 5, "circle-stroke-color": "#fff", "circle-stroke-width": 1.2 } });
    for (const t of ["fill", "line", "pt"]) {
      map.on("click", `res-${id}-${t}`, (e) => popup(e, `${LABELS[id]} result`));
      hoverCursor(`res-${id}-${t}`);
    }
  }
  styleResults();
}

function hoverCursor(id) {
  map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
}

// One engine's result on its own tab; on Compare, all three as nested rings so
// agreement shows as a bullseye and disagreement shows up in red.
function styleResults() {
  if (!map.getSource("res-turf")) return;
  const compare = state.tab === "compare";
  const ring = { turf: 8, duckdb: 5.5, geopandas: 3 };
  const width = { turf: 7, duckdb: 4, geopandas: 1.8 };
  for (const id of IDS) {
    const show = compare || state.tab === id;
    for (const t of ["fill", "line", "pt"]) map.setLayoutProperty(`res-${id}-${t}`, "visibility", show ? "visible" : "none");
    if (compare) {
      const filled = id === "geopandas";
      map.setPaintProperty(`res-${id}-pt`, "circle-radius", ring[id]);
      map.setPaintProperty(`res-${id}-pt`, "circle-opacity", filled ? 1 : 0);
      map.setPaintProperty(`res-${id}-pt`, "circle-stroke-color", COLORS[id]);
      map.setPaintProperty(`res-${id}-pt`, "circle-stroke-width", filled ? 0 : 2);
      map.setPaintProperty(`res-${id}-line`, "line-width", width[id]);
      map.setPaintProperty(`res-${id}-line`, "line-opacity", id === "turf" ? 0.35 : id === "duckdb" ? 0.6 : 1);
      map.setPaintProperty(`res-${id}-fill`, "fill-opacity", 0.08);
    } else {
      map.setPaintProperty(`res-${id}-pt`, "circle-radius", 5);
      map.setPaintProperty(`res-${id}-pt`, "circle-opacity", 1);
      map.setPaintProperty(`res-${id}-pt`, "circle-stroke-color", "#fff");
      map.setPaintProperty(`res-${id}-pt`, "circle-stroke-width", 1.2);
      map.setPaintProperty(`res-${id}-line`, "line-width", 2.5);
      map.setPaintProperty(`res-${id}-line`, "line-opacity", 1);
      map.setPaintProperty(`res-${id}-fill`, "fill-opacity", 0.3);
    }
  }
  for (const t of ["fill", "line", "pt"]) map.setLayoutProperty(`res-diff-${t}`, "visibility", compare ? "visible" : "none");
}

function setEngineResult(id, res) {
  state.threads[id].result = res;
  if (!map.getSource(`res-${id}`)) return;
  map.getSource(`res-${id}`).setData(res && res.kind === "features" ? res.geojson : empty());
}

function fitToResults() {
  const fc = { type: "FeatureCollection", features: IDS.flatMap((id) => {
    const r = state.threads[id].result;
    return r && r.kind === "features" ? r.geojson.features : [];
  }) };
  const b = bbox(fc);
  if (b) map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 60, maxZoom: 10, duration: 900 });
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

const empty = () => ({ type: "FeatureCollection", features: [] });
let lastDiff = empty();

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
    L.mapLayers.forEach((id) => map.setLayoutProperty(id, "visibility", e.target.checked ? "visible" : "none"));
  });
}

// ---------- data ----------

async function loadData() {
  state.manifest = await (await fetch("data/layers.json")).json();
  await Promise.all(state.manifest.map(async (L) => {
    state.layers[L.id] = await (await fetch(`data/${L.file}`)).json();
  }));
  state.schema = describeLayers();
}

function describeLayers() {
  return state.manifest.map((L) => {
    const fc = state.layers[L.id];
    const fields = {};
    for (const f of fc.features) {
      for (const [k, v] of Object.entries(f.properties || {})) {
        if (v == null || v === "") continue;
        const s = (fields[k] ||= { type: typeof v, vals: new Set(), min: Infinity, max: -Infinity });
        if (typeof v === "number") { s.min = Math.min(s.min, v); s.max = Math.max(s.max, v); }
        else if (s.vals.size < 40) s.vals.add(String(v));
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
    return `Layer "${L.id}" - ${L.name}: ${fc.features.length} features (${g}). ${L.description || ""}\n${lines.join("\n")}`;
  }).join("\n\n");
}

// ---------- engines ----------

function ensureEngine(id) {
  if (ENGINES[id].dead) {
    ENGINES[id].dead = false;
    delete state.ready[id];
  }
  if (!state.ready[id]) {
    const eng = ENGINES[id];
    setEngineStatus(id, "loading", `Loading ${eng.label}...`);
    state.ready[id] = eng
      .load(state.layers, (msg) => setEngineStatus(id, "loading", msg))
      .then(() => setEngineStatus(id, "ready", `${eng.label} ready · ${eng.blurb}`))
      .catch((e) => {
        delete state.ready[id];
        setEngineStatus(id, "error", `${eng.label} failed to load: ${e.message}`);
        throw e;
      });
  }
  return state.ready[id];
}

function setEngineStatus(id, kind, text) {
  state.engineStatus[id] = { kind, text };
  const el = $(`#panel-${id} .engine-line`);
  if (el) {
    el.className = `engine-line status ${kind}`;
    el.textContent = text;
  }
  renderTab(id);
}

async function runCode(id, code) {
  await ensureEngine(id);
  const t0 = performance.now();
  const res = await ENGINES[id].run(stripFences(code));
  return { res, ms: performance.now() - t0 };
}

// ---------- Claude ----------

const TOOL = {
  name: "run_analysis",
  description: "Run code in your engine against the map layers. Geometry results are drawn on the map; other results come back as a table or value.",
  input_schema: {
    type: "object",
    properties: {
      code: { type: "string", description: "Code in your engine's language only." },
      title: { type: "string", description: 'Short label for the result, e.g. "Suspended fields near active platforms".' },
    },
    required: ["code", "title"],
  },
};

const DATA_NOTE = "Data is public open data (NSTA, Crown Estate Scotland, The Crown Estate), simplified for the demo. It may be out of date.";

function specPrompt() {
  return `You plan the analysis for a public demo: a map of UK North Sea energy infrastructure. Three engines (Turf.js, DuckDB Spatial and GeoPandas) will each implement your spec on their own, and visitors compare their answers side by side. So the spec must leave nothing open to interpretation.

DATA ON THE MAP
${state.schema}

Turn the visitor's latest question into a spec. Say:
- which layer or layers, and the exact filter values (use the field values listed above, e.g. status = 'ACTIVE')
- any distance or area threshold, with units. Distances are measured to the outline of a feature. If the visitor says "near" with no number, use 10 km and say so.
- what to return. If the answer is a set of places (wells, fields, platforms, sites, pipelines), draw those features on the map and carry any counts, distances or names as properties. Only return a table for rankings or totals that group many features (named columns, sort order and limit; default top 10).
Don't name a projection, CRS, library or measuring method. Each engine measures distance and area its own way, and that difference is part of what visitors compare.
Keep it to two or three sentences of plain English. No code.
Use earlier turns to resolve follow-ups like "now just the gas ones" into a complete spec.
Text values are mostly UPPER CASE in the data; match names case-insensitively.
Reply with <spec>...</spec> and nothing else. If these layers can't answer the question, reply <cannot>one sentence on why, then one question they could answer</cannot>.
${DATA_NOTE}`;
}

function enginePrompt(id) {
  const eng = ENGINES[id];
  return `You are one of three engines in a public demo: a map of UK North Sea energy infrastructure. A planning step has already turned the visitor's question into a precise spec. Implement that spec exactly in ${eng.label} (${eng.language}): same layers, filters, thresholds and output properties or columns. Don't reinterpret it. Visitors compare the three engines' answers, so any difference should come from the engine, not from you.

YOUR ENGINE: ${eng.label} (${eng.language})
${eng.guide}

DATA ON THE MAP
${state.schema}

HOW TO WORK
- Use run_analysis. Never guess counts, distances or names.
- If the code errors, read the error, fix it and try again (three tries at most).
- Text values are mostly UPPER CASE in the source data; match names case-insensitively.
- Final answer: one to three plain sentences with the key numbers, written for an energy industry audience. Say what's drawn on the map if anything. No markdown headings or tables.
- ${DATA_NOTE}`;
}

// Thinking blocks are bound to the system prompt they were written under. Older
// turns don't need them, so drop them before each new question.
function dropOldThinking(history) {
  return history.map((m) => {
    if (m.role !== "assistant" || !Array.isArray(m.content)) return m;
    const content = m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
    return { ...m, content: content.length ? content : [{ type: "text", text: "(no reply)" }] };
  });
}

// Every tool call must be answered by a tool result in the very next message,
// or the API rejects the whole conversation. If an earlier exchange was cut
// short, drop the unanswered calls rather than let one glitch break the thread.
function repair(history) {
  return history.map((m, i) => {
    if (m.role !== "assistant" || !Array.isArray(m.content)) return m;
    const ids = m.content.filter((b) => b.type === "tool_use").map((b) => b.id);
    if (!ids.length) return m;
    const next = history[i + 1];
    const answered = new Set(
      next && next.role === "user" && Array.isArray(next.content)
        ? next.content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id)
        : []
    );
    if (ids.every((id) => answered.has(id))) return m;
    const text = m.content.filter((b) => b.type === "text");
    return { ...m, content: text.length ? text : [{ type: "text", text: "(stopped before running)" }] };
  });
}

function trim(history) {
  // Keep the last few questions. Cut only at a plain user message so tool pairs stay intact.
  while (history.length > 24) {
    const i = history.findIndex((m, idx) => idx > 0 && m.role === "user" && typeof m.content === "string");
    if (i <= 0) break;
    history = history.slice(i);
  }
  return history;
}

async function makeSpec(question) {
  state.specHistory = trim(dropOldThinking(state.specHistory));
  state.specHistory.push({ role: "user", content: question });
  try {
    const resp = await callClaude({ system: specPrompt(), messages: state.specHistory });
    const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (resp.stop_reason === "max_tokens" && !/<\/spec>|<\/cannot>/i.test(text)) {
      throw new Error("Claude ran out of room while planning. Try a simpler question.");
    }
    state.specHistory.push({ role: "assistant", content: text || "(no reply)" });
    const spec = text.match(/<spec>([\s\S]*?)<\/spec>/i);
    const cannot = text.match(/<cannot>([\s\S]*?)<\/cannot>/i);
    if (cannot) return { cannot: cannot[1].trim() };
    return { spec: (spec ? spec[1] : text).trim() };
  } catch (e) {
    state.specHistory.pop();
    throw e;
  }
}

async function runThread(id, question, spec, round) {
  const t = state.threads[id];
  t.result = null;
  t.phase = "working";
  renderTab(id);
  try {
    await ensureEngine(id);
  } catch (e) {
    addNote(round, `${LABELS[id]} couldn't load, so it can't answer this one.`);
    t.phase = "error";
    renderTab(id);
    return null;
  }

  t.history = repair(trim(dropOldThinking(t.history)));
  const before = t.history.length;
  t.history.push({ role: "user", content: `Visitor's question: ${question}\n\nSpec to implement exactly: ${spec}` });
  let last = null;
  try {
    for (let i = 0; i < CONFIG.maxToolRounds; i++) {
      const resp = await callClaude({ system: enginePrompt(id), messages: t.history, tools: [TOOL] });
      t.history.push({ role: "assistant", content: resp.content });
      if (resp.stop_reason === "max_tokens") {
        t.history.pop();
        addNote(round, "Claude ran out of room before finishing its code (it thinks first, then writes). Try again, or ask a narrower question.");
        break;
      }
      for (const b of resp.content) if (b.type === "text" && b.text.trim()) addText(round, b.text);
      const uses = resp.content.filter((b) => b.type === "tool_use");
      if (resp.stop_reason !== "tool_use" || !uses.length) {
        if (!last && !resp.content.some((b) => b.type === "text" && b.text.trim())) addNote(round, "Claude finished without running any code.");
        break;
      }

      const results = [];
      for (const u of uses) {
        const card = addCodeCard(round, id, u.input.title, u.input.code);
        try {
          const { res, ms } = await runCode(id, u.input.code);
          fillCard(card, res, ms);
          last = { res, ms };
          setEngineResult(id, res);
          results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(summariseForClaude(res, ms)) });
        } catch (e) {
          failCard(card, e);
          results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: String(e.message || e).slice(0, 1500) });
        }
      }
      t.history.push({ role: "user", content: results });
    }
  } catch (e) {
    // Roll the thread back to before this question, so a half-finished
    // exchange can't break the next one.
    t.history = t.history.slice(0, before);
    t.phase = "error";
    renderTab(id);
    if (e instanceof LimitReached) throw e;
    addNote(round, `Something went wrong talking to Claude: ${e.message}`);
    return last && last.res;
  }
  t.phase = last ? "done" : "error";
  renderTab(id);
  return last && last.res;
}

async function ask(question) {
  setSpec(null);
  setSummary("Working out exactly what to calculate...", "working");
  let plan;
  try {
    plan = await makeSpec(question);
  } catch (e) {
    return handleLimit(e) || setSummary(`Something went wrong talking to Claude: ${e.message}`, "error");
  }
  if (plan.cannot) {
    setSpec(null);
    return setSummary(plan.cannot, "error");
  }
  setSpec(plan.spec);
  setSummary("Three engines working on it...", "working");

  const rounds = Object.fromEntries(IDS.map((id) => [id, startRound(id, question)]));
  IDS.forEach((id) => setEngineResult(id, null));
  try {
    await Promise.all(IDS.map((id) => runThread(id, question, plan.spec, rounds[id])));
  } catch (e) {
    if (!handleLimit(e)) setSummary(`Something went wrong: ${e.message}`, "error");
  }
  finishRound();
}

function handleLimit(e) {
  if (!(e instanceof LimitReached)) return false;
  state.forcedOffline = true;
  updateMode();
  setSummary(`${e.message} The example questions still work (pre-written code), or add your own API key with ⚙.`, "error");
  return true;
}

async function runExample(ex) {
  setSpec(ex.spec, true);
  setSummary("Running the pre-written code on all three engines...", "working");
  IDS.forEach((id) => setEngineResult(id, null));
  await Promise.all(IDS.map(async (id) => {
    const round = startRound(id, ex.question);
    const t = state.threads[id];
    t.phase = "working";
    renderTab(id);
    const card = addCodeCard(round, id, ex.short, ex.code[id], true);
    try {
      const { res, ms } = await runCode(id, ex.code[id]);
      fillCard(card, res, ms);
      setEngineResult(id, res);
      addText(round, ex.answer(res), true);
      t.phase = "done";
    } catch (e) {
      failCard(card, e);
      t.phase = "error";
    }
    renderTab(id);
  }));
  finishRound();
}

function finishRound() {
  const results = Object.fromEntries(IDS.map((id) => [id, state.threads[id].result]));
  const c = compareResults(results, LABELS);
  lastDiff = c.diff;
  map.getSource("res-diff")?.setData(c.diff);
  $("#panel-compare .cmp-body").innerHTML = c.html || "";
  const counts = IDS.map((id) => `<span class="sc eng-${id}"><i class="dot eng-${id} on"></i>${esc(LABELS[id])} <b>${esc(countText(results[id]))}</b></span>`).join("");
  const level = c.level || (c.diff.features.length || /disagree|differ|missing|didn't/.test(c.headline) ? "diff" : "agree");
  setSummary(`${counts}<span class="verdict">${esc(c.headline)}</span>`, level, true);
  fitToResults();
}

function countText(res) {
  if (!res) return "–";
  if (res.kind === "features") return String(res.count);
  if (res.kind === "table") return `${res.count} rows`;
  return fmtVal(res.value);
}

// ---------- results UI ----------

function startRound(id, question) {
  const log = $(`#panel-${id} .log`);
  const d = document.createElement("div");
  d.className = "round";
  d.innerHTML = `<div class="q">${esc(question)}</div>`;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}

function scrollRound(round) {
  const log = round.parentElement;
  log.scrollTop = log.scrollHeight;
}

function addText(round, text, offline = false) {
  const d = document.createElement("div");
  d.className = "answer" + (offline ? " offline" : "");
  d.innerHTML = md(text);
  round.appendChild(d);
  scrollRound(round);
}

function addNote(round, text) {
  const d = document.createElement("div");
  d.className = "note";
  d.textContent = text;
  round.appendChild(d);
  scrollRound(round);
}

function addCodeCard(round, id, title, code, prewritten = false) {
  const eng = ENGINES[id];
  const d = document.createElement("div");
  d.className = `card eng-${id}`;
  const lines = code.trim().split("\n").length;
  d.innerHTML = `
    <div class="card-head">
      <span class="card-title">${esc(title || "Analysis")}</span>
      <span class="card-meta">running...</span>
    </div>
    <details>
      <summary>${prewritten ? "Pre-written" : "Claude's"} ${esc(eng.language)} · ${lines} line${lines === 1 ? "" : "s"}</summary>
      <pre><code>${esc(code.trim())}</code></pre>
    </details>
    <div class="card-out"></div>`;
  round.appendChild(d);
  scrollRound(round);
  return d;
}

function fillCard(card, res, ms) {
  const what = res.kind === "features" ? `${res.count} on map` : res.kind === "table" ? `${res.count} rows` : "value";
  card.querySelector(".card-meta").textContent = `${fmtMs(ms)} · ${what}`;
  const out = card.querySelector(".card-out");
  if (res.kind === "table") out.innerHTML = table(res.rows);
  else if (res.kind === "value") out.innerHTML = `<div class="value">${esc(fmtVal(res.value))}</div>`;
}

function failCard(card, e) {
  card.classList.add("failed");
  card.querySelector(".card-meta").textContent = "error";
  card.querySelector(".card-out").innerHTML = `<pre class="err">${esc(String(e.message || e))}</pre>`;
}

function table(rows) {
  if (!rows.length) return `<div class="value">No rows</div>`;
  const cols = Object.keys(rows[0]).slice(0, 6);
  const body = rows.slice(0, 10).map((r) => `<tr>${cols.map((c) => `<td>${esc(fmtVal(r[c]))}</td>`).join("")}</tr>`).join("");
  const more = rows.length > 10 ? `<div class="more">+ ${rows.length - 10} more</div>` : "";
  return `<div class="tbl"><table><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>${body}</table></div>${more}`;
}

function renderTab(id) {
  const btn = $(`.tab[data-tab="${id}"]`);
  if (!btn) return;
  const t = state.threads[id];
  const es = state.engineStatus[id];
  let phase = t.phase;
  if (phase === "idle" && es && es.kind === "loading") phase = "loading";
  if (phase === "idle" && es && es.kind === "error") phase = "error";
  btn.dataset.phase = phase;
  btn.querySelector(".n").textContent = t.result ? countText(t.result) : "";
}

function selectTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.dataset.tab !== tab));
  styleResults();
}

function setSpec(text, prewritten = false) {
  const el = $("#spec");
  el.hidden = !text;
  if (text) el.innerHTML = `<b>${prewritten ? "Example spec" : "Claude's spec"}</b> ${esc(text)}`;
}

function setSummary(html, kind = "", isHtml = false) {
  const el = $("#summary");
  el.className = `summary ${kind}`;
  if (isHtml) el.innerHTML = html;
  else el.textContent = html;
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
  pill.textContent = mode === "offline" ? "Examples only" : "Live · Claude Haiku";
  $("#input").disabled = mode === "offline";
  $("#input").placeholder = mode === "offline"
    ? "Live questions are off. Pick an example below, or add your own key (⚙)."
    : "Ask about the wells, fields, platforms, pipelines, licences or wind sites...";
  $("#send").disabled = mode === "offline";
}

async function busy(fn) {
  state.busy = true;
  document.body.classList.add("busy");
  try {
    await fn();
  } finally {
    state.busy = false;
    document.body.classList.remove("busy");
  }
}

function buildExamples() {
  const el = $("#examples");
  el.innerHTML = EXAMPLES.map((ex, i) => `<button data-i="${i}" title="${esc(ex.question)}"><b>${esc(ex.short)}</b> ${esc(ex.question)}</button>`).join("");
  el.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b || state.busy) return;
    const ex = EXAMPLES[+b.dataset.i];
    $("#input").value = state.mode === "offline" ? "" : ex.question;
    await busy(async () => {
      if (state.mode === "offline") return runExample(ex);
      await ask(ex.question);
      // Hit the daily limit on this one? Show the pre-written version instead.
      if (state.mode === "offline") {
        $("#input").value = "";
        await runExample(ex);
      }
    });
  });
}

function wireControls() {
  const form = $("#ask");
  const input = $("#input");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q || state.busy || state.mode === "offline") return;
    await busy(() => ask(q));
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));

  $("#clear").addEventListener("click", () => {
    if (state.busy) return;
    state.specHistory = [];
    for (const id of IDS) {
      state.threads[id] = { history: [], result: null, phase: "idle" };
      setEngineResult(id, null);
      $(`#panel-${id} .log`).innerHTML = "";
      renderTab(id);
    }
    map.getSource("res-diff")?.setData(empty());
    $("#panel-compare .cmp-body").innerHTML = "";
    $("#input").value = "";
    setSpec(null);
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
  setSummary("Ask a question, or pick an example. Claude pins down exactly what to calculate, then Turf.js, DuckDB and GeoPandas each do it their own way. Flick through the tabs to see each engine's code and answer, or open Compare to see where they agree.");
}

// ---------- start ----------

(async function start() {
  $("#author").innerHTML = `<a href="${CONFIG.author.url}" target="_blank" rel="noopener">${esc(CONFIG.author.name)}</a>`;
  wireControls();
  updateMode();
  intro();
  selectTab("turf");
  IDS.forEach((id) => setEngineStatus(id, "idle", `${ENGINES[id].label} · ${ENGINES[id].blurb}. Loads on first use.`));
  try {
    await loadData();
  } catch (e) {
    setSummary(`Couldn't load the map data: ${e.message}`, "error");
    return;
  }
  buildExamples();
  // Turf is instant. On a desktop, warm up the heavier engines in the background
  // so the first question isn't spent waiting for downloads. None of this waits
  // for the map, which doesn't draw while the tab is in the background.
  ensureEngine("turf")
    .catch(() => {})
    .finally(() => {
      if (!matchMedia("(max-width: 820px)").matches) {
        ensureEngine("duckdb").catch(() => {}).finally(() => ensureEngine("geopandas").catch(() => {}));
      }
    });
  await mapLoaded;
  addDataLayers();
  buildLegend();
  // Draw anything that finished before the map was ready.
  IDS.forEach((id) => setEngineResult(id, state.threads[id].result));
  map.getSource("res-diff").setData(lastDiff);
})();
