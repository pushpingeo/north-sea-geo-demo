// Compare the three engines' results for one question.
// Returns a one-line headline, HTML for the Compare tab, and the features that
// not every engine found (drawn as a red halo on the map).

const KEY_FIELDS = ["well", "name", "pipeline", "licence", "operator", "field", "platform", "wind_site"];
const AGREE = 0.001; // within 0.1%: the same answer
const CLOSE = 0.02; // within 2%: same answer, measured differently

export function compareResults(results, labels) {
  const ids = Object.keys(results).filter((id) => results[id]);
  if (!ids.length) return { headline: "No engine produced a result.", html: "", diff: empty() };
  if (ids.length < Object.keys(results).length) {
    const missing = Object.keys(results).filter((id) => !results[id]).map((id) => labels[id]);
    return finish(compareSome(ids, results, labels), `${missing.join(" and ")} didn't produce a result.`);
  }
  return compareSome(ids, results, labels);
}

function finish(c, note) {
  return { ...c, headline: note + " " + c.headline, html: `<p class="cmp-note">${esc(note)}</p>` + c.html };
}

function compareSome(ids, results, labels) {
  const kinds = new Set(ids.map((id) => results[id].kind));
  if (kinds.size > 1) {
    const html = `<p>The engines returned different kinds of answer: ${ids
      .map((id) => `${esc(labels[id])}: ${results[id].kind}`)
      .join(", ")}. That usually means one of them read the question differently.</p>`;
    return { headline: "The engines returned different kinds of answer.", html, diff: empty() };
  }
  const kind = [...kinds][0];
  if (kind === "features") return compareFeatures(ids, results, labels);
  if (kind === "table") return compareTables(ids, results, labels);
  return compareValues(ids, results, labels);
}

const empty = () => ({ type: "FeatureCollection", features: [] });

// ---------- features ----------

function compareFeatures(ids, results, labels) {
  const fcs = Object.fromEntries(ids.map((id) => [id, results[id].geojson.features]));
  const keyFields = KEY_FIELDS.filter((k) => ids.every((id) => fcs[id].length === 0 || fcs[id].some((f) => f.properties?.[k] != null)));
  // Use one or two identifying fields if every engine has them, otherwise the geometry.
  const keyOf = keyFields.length
    ? (f) => keyFields.slice(0, 2).map((k) => String(f.properties?.[k] ?? "")).join(" · ")
    : geomKey;
  const keyLabel = keyFields.length ? keyFields.slice(0, 2).join(" + ") : "location";

  const sets = {};
  const byKey = new Map();
  for (const id of ids) {
    sets[id] = new Set();
    for (const f of fcs[id]) {
      const k = keyOf(f);
      sets[id].add(k);
      if (!byKey.has(k)) byKey.set(k, f);
    }
  }
  const all = [...byKey.keys()];
  const partial = all.filter((k) => !ids.every((id) => sets[id].has(k)));
  const counts = ids.map((id) => `${labels[id]} ${fcs[id].length}`);

  const diff = {
    type: "FeatureCollection",
    features: partial.map((k) => ({
      ...byKey.get(k),
      properties: { ...byKey.get(k).properties, found_by: ids.filter((id) => sets[id].has(k)).map((id) => labels[id]).join(", ") },
    })),
  };

  const sameCount = new Set(ids.map((id) => fcs[id].length)).size === 1;
  let headline;
  if (!partial.length && sameCount) headline = `${agreeWord(ids)} ${fcs[ids[0]].length} features.`;
  else if (!partial.length) headline = `Same ${all.length} ${keyLabel} values, but different counts (${counts.join(", ")}).`;
  else headline = `${partial.length} of ${all.length} not found by every engine.`;

  let html = `<table class="cmp"><tr><th></th>${ids.map((id) => th(id, labels)).join("")}</tr>
    <tr><td>Features</td>${ids.map((id) => `<td>${fcs[id].length}</td>`).join("")}</tr>
    <tr><td>Distinct by ${esc(keyLabel)}</td>${ids.map((id) => `<td>${sets[id].size}</td>`).join("")}</tr></table>`;
  if (partial.length) {
    html += `<h4>Where they disagree <span class="hint">(red on the map)</span></h4><ul class="cmp-list">`;
    for (const k of partial.slice(0, 25)) {
      html += `<li><span>${esc(k)}</span>${ids
        .map((id) => `<i class="dot eng-${id} ${sets[id].has(k) ? "on" : "off"}" title="${esc(labels[id])}"></i>`)
        .join("")}</li>`;
    }
    if (partial.length > 25) html += `<li class="more">+ ${partial.length - 25} more</li>`;
    html += `</ul>`;
  } else {
    html += `<p class="cmp-ok">Every feature was found by ${ids.length === 3 ? "all three engines" : "every engine that answered"}. On the map, the coloured rings sit on top of each other.</p>`;
  }
  return { headline, html, diff };
}

function geomKey(f) {
  let c = f.geometry && f.geometry.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  return Array.isArray(c) ? `${c[0].toFixed(4)},${c[1].toFixed(4)}` : "?";
}

// ---------- tables ----------

function compareTables(ids, results, labels) {
  const rows = Object.fromEntries(ids.map((id) => [id, results[id].rows]));
  const first = rows[ids[0]][0] || {};
  const keyCol = Object.keys(first).find((k) => typeof first[k] === "string");
  const numCol = (id) => Object.keys(rows[id][0] || {}).find((k) => typeof rows[id][0][k] === "number");

  if (!keyCol) return compareValues(ids, Object.fromEntries(ids.map((id) => [id, { kind: "value", value: rows[id].length }])), labels);

  const maps = {};
  const order = [];
  for (const id of ids) {
    const nc = numCol(id);
    maps[id] = new Map(rows[id].map((r) => [String(r[keyCol]), nc ? r[nc] : null]));
    for (const r of rows[id]) if (!order.includes(String(r[keyCol]))) order.push(String(r[keyCol]));
  }

  let worst = 0;
  let disagreements = 0;
  let close = 0;
  const body = order.slice(0, 15).map((k) => {
    const vals = ids.map((id) => maps[id].get(k));
    const present = vals.filter((v) => v !== undefined);
    const nums = present.filter((v) => typeof v === "number");
    let gap = 0;
    let absGap = 0;
    if (nums.length > 1) {
      const lo = Math.min(...nums), hi = Math.max(...nums);
      absGap = hi - lo;
      gap = hi === 0 ? 0 : absGap / Math.abs(hi);
      worst = Math.max(worst, gap);
    }
    // Small rounded numbers (0.4 km vs 0.5 km) are a rounding difference, not a disagreement.
    const cls = present.length < ids.length || (gap > CLOSE && absGap > 0.15) ? "bad" : gap > AGREE ? "close" : "";
    if (cls === "bad") disagreements++;
    if (cls === "close") close++;
    return `<tr class="${cls}"><td>${esc(k)}</td>${vals
      .map((v) => `<td>${v === undefined ? "<em>missing</em>" : esc(fmt(v))}</td>`)
      .join("")}<td class="gap">${nums.length > 1 ? (gap * 100).toFixed(2) + "%" : ""}</td></tr>`;
  });

  const pct = (worst * 100).toFixed(2);
  let headline, level;
  if (disagreements) {
    headline = `${disagreements} row${disagreements === 1 ? "" : "s"} differ by more than 2%, or are missing from an engine.`;
    level = "diff";
  } else if (close) {
    headline = `Close but not identical: the biggest gap is ${pct}%. That comes from how each engine measures, not from a mistake.`;
    level = "close";
  } else {
    headline = `${agreeWord(ids)} the same numbers (largest gap ${pct}%).`;
    level = "agree";
  }
  const html = `<table class="cmp"><tr><th>${esc(keyCol)}</th>${ids.map((id) => th(id, labels)).join("")}<th>gap</th></tr>${body.join("")}</table>
    <p class="hint">Showing the first number column from each engine. Small gaps usually come from how each engine measures: Turf on the sphere, DuckDB and GeoPandas on British National Grid.</p>`;
  return { headline, html, level, diff: empty() };
}

// ---------- single values ----------

function compareValues(ids, results, labels) {
  const vals = ids.map((id) => results[id].value);
  let agree;
  let note = "";
  if (vals.every((v) => typeof v === "number")) {
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const gap = hi === 0 ? 0 : (hi - lo) / Math.abs(hi);
    agree = gap <= CLOSE;
    note = ` (gap ${(gap * 100).toFixed(2)}%)`;
  } else {
    agree = new Set(vals.map((v) => JSON.stringify(v))).size === 1;
  }
  const headline = agree ? `${agreeWord(ids).replace(/:$/, "")}${note}.` : `The engines disagree${note}.`;
  const level = agree ? (note && !note.includes("0.00%") ? "close" : "agree") : "diff";
  const html = `<table class="cmp"><tr>${ids.map((id) => th(id, labels)).join("")}</tr><tr>${vals
    .map((v) => `<td class="big">${esc(fmt(v))}</td>`)
    .join("")}</tr></table>`;
  return { headline, html, level, diff: empty() };
}

// ---------- helpers ----------

const agreeWord = (ids) => (ids.length === 3 ? "All three agree:" : ids.length === 2 ? "The other two agree:" : "Only one engine answered:");

const th = (id, labels) => `<th><i class="dot eng-${id} on"></i>${esc(labels[id])}</th>`;

function fmt(v) {
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (v == null) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
