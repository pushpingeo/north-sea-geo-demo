// Every engine hands back the same shape, so the map, the chat and Claude
// never need to know which library did the work.
//
//   { kind: "features", geojson: FeatureCollection, count }
//   { kind: "table",    rows: [ {...}, ... ],        count }
//   { kind: "value",    value: any }

export function normalise(out) {
  if (out == null) return { kind: "value", value: null };
  if (out.type === "FeatureCollection") {
    return { kind: "features", geojson: out, count: out.features.length };
  }
  if (out.type === "Feature") {
    return normalise({ type: "FeatureCollection", features: [out] });
  }
  if (out.type && out.coordinates) {
    return normalise({ type: "Feature", properties: {}, geometry: out });
  }
  if (Array.isArray(out)) {
    if (out.length && out.every((r) => r && r.type === "Feature")) {
      return normalise({ type: "FeatureCollection", features: out });
    }
    const rows = out.map((r) => (r && typeof r === "object" ? r : { value: r }));
    return { kind: "table", rows, count: rows.length };
  }
  if (typeof out === "object") {
    return { kind: "table", rows: [out], count: 1 };
  }
  return { kind: "value", value: out };
}

const clip = (v) => {
  if (typeof v === "number") return Number.isInteger(v) ? v : Math.round(v * 1000) / 1000;
  if (typeof v === "string" && v.length > 80) return v.slice(0, 77) + "...";
  if (v && typeof v === "object") return clip(JSON.stringify(v));
  return v;
};

// What Claude sees back from the tool. Small on purpose: Claude only needs
// enough to write the answer, and the visitor sees the full result on the map.
export function summariseForClaude(res, ms) {
  const base = { engine_ms: Math.round(ms) };
  if (res.kind === "value") return { ...base, kind: "value", value: clip(res.value) };
  const rows =
    res.kind === "features" ? res.geojson.features.map((f) => f.properties || {}) : res.rows;
  const sample = rows.slice(0, 15).map((r) => {
    const o = {};
    for (const [k, v] of Object.entries(r)) o[k] = clip(v);
    return o;
  });
  const out = { ...base, kind: res.kind, count: res.count, first_rows: sample };
  if (res.kind === "features") {
    out.drawn_on_map = true;
    out.geometry_types = [...new Set(res.geojson.features.map((f) => f.geometry && f.geometry.type))];
  }
  let txt = JSON.stringify(out);
  while (txt.length > 4000 && out.first_rows.length > 1) {
    out.first_rows.pop();
    txt = JSON.stringify(out);
  }
  return out;
}

export function bbox(fc) {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (c) => {
    if (typeof c[0] === "number") {
      b = [Math.min(b[0], c[0]), Math.min(b[1], c[1]), Math.max(b[2], c[0]), Math.max(b[3], c[1])];
    } else c.forEach(walk);
  };
  for (const f of fc.features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "GeometryCollection") g.geometries.forEach((gg) => walk(gg.coordinates));
    else walk(g.coordinates);
  }
  return b[0] === Infinity ? null : b;
}
