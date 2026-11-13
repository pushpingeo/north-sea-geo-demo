// Example questions, written with an industry hat on.
//
// With Claude connected these are just shortcuts: Claude writes the spec and the code.
// Without a live connection the page runs this pre-written code instead (clearly
// labelled), so visitors can still see three engines answer the same question.

const props = (res) =>
  res.kind === "features" ? res.geojson.features.map((f) => f.properties || {}) : res.rows || [];

const tally = (rows, key) => {
  const m = {};
  for (const r of rows) if (r[key] != null) m[r[key]] = (m[r[key]] || 0) + 1;
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
};

const list = (xs, n = 4) => (xs.length > n ? xs.slice(0, n).join(", ") + " and others" : xs.join(", "));

export const EXAMPLES = [
  {
    question: "Which offshore wind sites have legacy oil and gas wells inside them?",
    short: "Old wells inside wind leases",
    spec: "Find every well (any status) that lies inside an offshore wind site. Draw those wells, with properties well, status and wind_site (the wind site's name). If sites overlap, keep one row per well and site.",
    code: {
      turf: `const sites = layers.wind.features.map((w) => [w, turf.bbox(w)]);
const out = [];
for (const well of layers.wells.features) {
  const [x, y] = well.geometry.coordinates;
  for (const [site, b] of sites) {
    if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue; // quick box check
    if (turf.booleanPointInPolygon(well, site)) {
      out.push(turf.point([x, y], {
        well: well.properties.well,
        status: well.properties.status,
        wind_site: site.properties.name,
      }));
    }
  }
}
return turf.featureCollection(out);`,
      duckdb: `SELECT w.well, w.status, s.name AS wind_site, w.geom
FROM wells w
JOIN wind s ON ST_Within(w.geom, s.geom)`,
      geopandas: `wells = layers["wells"][["well", "status", "geometry"]]
sites = layers["wind"][["name", "geometry"]].rename(columns={"name": "wind_site"})

result = gpd.sjoin(wells, sites, predicate="within").drop(columns="index_right")`,
    },
    answer: (res) => {
      const rows = props(res);
      const sites = tally(rows, "wind_site");
      const decom = rows.filter((r) => r.status === "Decommissioned").length;
      if (!rows.length) return "No wells fall inside a wind site.";
      return `${rows.length} wells sit inside ${sites.length} wind sites. ${sites[0][0]} has the most (${sites[0][1]}). ${decom} are decommissioned. That's the developer's problem now: cable routes and turbine positions have to work around them, and a badly abandoned well can need re-entering.`;
    },
  },
  {
    question: "Which active platforms sit on fields that have stopped producing?",
    short: "Decommissioning pipeline",
    spec: "Find platforms with status 'ACTIVE' that lie inside a field whose status starts with 'PRODUCTION CEASED' or equals 'POST-COP'. Draw those platforms, with properties name, operator and field (the field's name).",
    code: {
      turf: `const ceased = layers.fields.features
  .filter((f) => f.properties.status.startsWith("PRODUCTION CEASED") || f.properties.status === "POST-COP")
  .map((f) => [f, turf.bbox(f)]);

const out = [];
for (const p of layers.platforms.features) {
  if (p.properties.status !== "ACTIVE") continue;
  const [x, y] = p.geometry.coordinates;
  for (const [f, b] of ceased) {
    if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
    if (turf.booleanPointInPolygon(p, f)) {
      out.push(turf.point([x, y], {
        name: p.properties.name, operator: p.properties.operator, field: f.properties.name,
      }));
    }
  }
}
return turf.featureCollection(out);`,
      duckdb: `SELECT p.name, p.operator, f.name AS field, p.geom
FROM platforms p
JOIN fields f ON ST_Within(p.geom, f.geom)
WHERE p.status = 'ACTIVE'
  AND (f.status LIKE 'PRODUCTION CEASED%' OR f.status = 'POST-COP')`,
      geopandas: `plats = layers["platforms"].query("status == 'ACTIVE'")[["name", "operator", "geometry"]]

fields = layers["fields"]
ceased = fields[fields.status.str.startswith("PRODUCTION CEASED") | (fields.status == "POST-COP")]
ceased = ceased[["name", "geometry"]].rename(columns={"name": "field"})

result = gpd.sjoin(plats, ceased, predicate="within").drop(columns="index_right")`,
    },
    answer: (res) => {
      const rows = props(res);
      const ops = tally(rows, "operator");
      if (!rows.length) return "None found.";
      return `${rows.length} installations are still listed as active on fields that have stopped producing. Think of it as a rough list of what's next in line for decommissioning, or for reuse such as carbon storage. ${ops[0][0]} has the most (${ops[0][1]}).`;
    },
  },
  {
    question: "Which suspended fields have an active platform within 10 km?",
    short: "Tie-back candidates",
    spec: "Find fields whose status contains 'SUSPENDED' that have at least one platform with status 'ACTIVE' within 10 km of the field outline. Draw those fields, with properties name, status, operator, nearest_platform (the closest active platform) and distance_km to it, rounded to 1 decimal place (0 if the platform is inside the field).",
    code: {
      turf: `const plats = layers.platforms.features.filter((p) => p.properties.status === "ACTIVE");
const out = [];
for (const f of layers.fields.features) {
  if (!f.properties.status.includes("SUSPENDED")) continue;
  let best = null;
  for (const p of plats) {
    // negative means the platform is inside the field
    const d = Math.max(0, turf.pointToPolygonDistance(p, f, { units: "kilometers" }));
    if (!best || d < best.d) best = { d, name: p.properties.name };
  }
  if (best && best.d <= 10) {
    out.push(turf.feature(f.geometry, {
      name: f.properties.name, status: f.properties.status, operator: f.properties.operator,
      nearest_platform: best.name, distance_km: Math.round(best.d * 10) / 10,
    }));
  }
}
return turf.featureCollection(out);`,
      duckdb: `WITH f AS (
  SELECT name, status, operator, geom,
         ST_Transform(geom, 'EPSG:4326', 'EPSG:27700', always_xy := true) AS g
  FROM fields WHERE status LIKE '%SUSPENDED%'
),
p AS (
  SELECT name, ST_Transform(geom, 'EPSG:4326', 'EPSG:27700', always_xy := true) AS g
  FROM platforms WHERE status = 'ACTIVE'
),
d AS (
  SELECT f.name, f.status, f.operator, f.geom, p.name AS nearest_platform,
         ST_Distance(f.g, p.g) / 1000 AS km,
         row_number() OVER (PARTITION BY f.name ORDER BY ST_Distance(f.g, p.g)) AS rn
  FROM f, p
)
SELECT name, status, operator, nearest_platform, round(km, 1) AS distance_km, geom
FROM d
WHERE rn = 1 AND km <= 10`,
      geopandas: `f = layers["fields"]
f = f[f.status.str.contains("SUSPENDED")][["name", "status", "operator", "geometry"]].to_crs(27700)

p = layers["platforms"].query("status == 'ACTIVE'")[["name", "geometry"]]
p = p.rename(columns={"name": "nearest_platform"}).to_crs(27700)

near = gpd.sjoin_nearest(f, p, max_distance=10000, distance_col="d").drop(columns="index_right")
near = near.sort_values("d").drop_duplicates("name")
near["distance_km"] = (near.d / 1000).round(1)
result = near.drop(columns="d")`,
    },
    answer: (res) => {
      const rows = props(res);
      if (!rows.length) return "None within 10 km.";
      const bits = rows.map((r) => `${r.name} (${r.nearest_platform}, ${r.distance_km} km)`);
      return `${rows.length} suspended fields have a working platform within 10 km: ${list(bits, 5)}. Being that close to live kit is what makes a restart or tie-back worth a look.`;
    },
  },
  {
    question: "Which 1 GW+ wind sites have active oil and gas platforms within 30 km?",
    short: "Electrification partners",
    spec: "Find offshore wind sites with capacity_mw of at least 1000 that have one or more platforms with status 'ACTIVE' within 30 km of the site outline. Draw those wind sites, with properties name, developer, capacity_mw and platforms_within_30km (the count).",
    code: {
      turf: `const plats = layers.platforms.features.filter((p) => p.properties.status === "ACTIVE");
const out = [];
for (const w of layers.wind.features) {
  if (!(w.properties.capacity_mw >= 1000)) continue;
  const n = plats.filter(
    (p) => Math.max(0, turf.pointToPolygonDistance(p, w, { units: "kilometers" })) <= 30
  ).length;
  if (n > 0) {
    out.push(turf.feature(w.geometry, {
      name: w.properties.name, developer: w.properties.developer,
      capacity_mw: w.properties.capacity_mw, platforms_within_30km: n,
    }));
  }
}
return turf.featureCollection(out);`,
      duckdb: `WITH w AS (
  SELECT name, developer, capacity_mw, geom,
         ST_Transform(geom, 'EPSG:4326', 'EPSG:27700', always_xy := true) AS g
  FROM wind WHERE capacity_mw >= 1000
),
p AS (
  SELECT ST_Transform(geom, 'EPSG:4326', 'EPSG:27700', always_xy := true) AS g
  FROM platforms WHERE status = 'ACTIVE'
)
SELECT w.name, w.developer, w.capacity_mw,
       count(*) AS platforms_within_30km,
       any_value(w.geom) AS geom
FROM w JOIN p ON ST_DWithin(w.g, p.g, 30000)
GROUP BY w.name, w.developer, w.capacity_mw`,
      geopandas: `w = layers["wind"].query("capacity_mw >= 1000")
w = w[["name", "developer", "capacity_mw", "geometry"]].to_crs(27700)
p = layers["platforms"].query("status == 'ACTIVE'")[["geometry"]].to_crs(27700)

j = gpd.sjoin(w, p, predicate="dwithin", distance=30000)
counts = j.groupby(level=0).size().rename("platforms_within_30km")
result = w.join(counts, how="inner")`,
    },
    answer: (res) => {
      const rows = props(res);
      if (!rows.length) return "None found.";
      const gw = rows.reduce((s, r) => s + (r.capacity_mw || 0), 0) / 1000;
      const top = [...rows].sort((a, b) => b.platforms_within_30km - a.platforms_within_30km)[0];
      return `${rows.length} big Scottish wind sites, about ${gw.toFixed(1)} GW between them, sit within 30 km of active platforms. ${top.name} has the most nearby (${top.platforms_within_30km}). These are the obvious places to talk about powering platforms from wind rather than gas turbines. Only Scottish sites have a published capacity in this data.`;
    },
  },
  {
    question: "Who operates the most licensed acreage, measured from the licence outlines?",
    short: "Acreage league table",
    spec: "Using the licences layer, measure each licence's area from its outline in square kilometres, add it up by operator, leave out 'NO OPERATOR', and return a table with columns operator and area_km2 (whole numbers), largest first, top 10.",
    code: {
      turf: `const totals = {};
for (const l of layers.licences.features) {
  const op = l.properties.operator;
  if (!op || op === "NO OPERATOR") continue;
  totals[op] = (totals[op] || 0) + turf.area(l) / 1e6; // turf.area is square metres
}
return Object.entries(totals)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
  .map(([operator, km2]) => ({ operator, area_km2: Math.round(km2) }));`,
      duckdb: `SELECT operator,
       round(sum(ST_Area(ST_Transform(geom, 'EPSG:4326', 'EPSG:27700', always_xy := true))) / 1e6) AS area_km2
FROM licences
WHERE operator IS NOT NULL AND operator <> 'NO OPERATOR'
GROUP BY operator
ORDER BY area_km2 DESC
LIMIT 10`,
      geopandas: `lic = layers["licences"]
lic = lic[lic.operator.notna() & (lic.operator != "NO OPERATOR")].to_crs(27700)

result = (lic.assign(area_km2=lic.area / 1e6)
             .groupby("operator", as_index=False).area_km2.sum()
             .sort_values("area_km2", ascending=False).head(10))
result["area_km2"] = result.area_km2.round().astype(int)`,
    },
    answer: (res) => {
      const top = props(res)[0];
      if (!top) return "No results.";
      return `${top.operator} operates the most licensed acreage, about ${Math.round(top.area_km2).toLocaleString()} km². Turf measures area on the sphere and the other two use British National Grid, so the totals differ a little. Open Compare to see by how much.`;
    },
  },
];
