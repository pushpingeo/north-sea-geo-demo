// Example questions. With Claude connected they're just shortcuts: Claude writes
// the code. Without a live connection the demo runs this pre-written code instead,
// clearly labelled, so visitors can still see the engine swap working.

const names = (res, key = "name", n = 5) =>
  res.kind === "features"
    ? res.geojson.features.slice(0, n).map((f) => f.properties[key]).filter(Boolean).join(", ")
    : "";

export const EXAMPLES = [
  {
    question: "Which offshore wind sites overlap an oil and gas licence?",
    title: "Wind sites overlapping petroleum licences",
    code: {
      turf: `const lic = layers.licences.features.map((l) => [l, turf.bbox(l)]);
const boxesTouch = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

const hits = layers.wind.features.filter((w) => {
  const wb = turf.bbox(w);
  return lic.some(([l, lb]) => boxesTouch(wb, lb) && turf.booleanIntersects(w, l));
});

return turf.featureCollection(hits.map((w) => turf.feature(w.geometry, {
  name: w.properties.name, developer: w.properties.developer,
  phase: w.properties.phase, region: w.properties.region,
})));`,
      duckdb: `SELECT w.name, w.developer, w.phase, w.region, w.geom
FROM wind w
WHERE EXISTS (
  SELECT 1 FROM licences l
  WHERE ST_Intersects(w.geom, l.geom)
)`,
      geopandas: `wind = layers["wind"]
lic = layers["licences"]

hits = gpd.sjoin(wind, lic[["geometry"]], predicate="intersects")
result = wind.loc[hits.index.unique(), ["name", "developer", "phase", "region", "geometry"]]`,
    },
    answer: (r) =>
      `${r.count} offshore wind sites overlap at least one current petroleum licence. They're in orange on the map${r.count ? ` (${names(r)}${r.count > 5 ? " and others" : ""})` : ""}.`,
  },
  {
    question: "Which producing fields are within 20 km of an offshore wind site?",
    title: "Producing fields within 20 km of wind sites",
    code: {
      turf: `const zones = layers.wind.features.map((w) => turf.buffer(w, 20, { units: "kilometers" }));

const hits = layers.fields.features.filter(
  (f) => f.properties.status === "PRODUCING" &&
         zones.some((z) => turf.booleanIntersects(f, z))
);

return turf.featureCollection(hits.map((f) => turf.feature(f.geometry, {
  name: f.properties.name, operator: f.properties.operator, type: f.properties.type,
})));`,
      duckdb: `WITH f AS (
  SELECT name, operator, type, geom,
         ST_Transform(geom, 'EPSG:4326', 'EPSG:27700', always_xy := true) AS g
  FROM fields WHERE status = 'PRODUCING'
),
w AS (
  SELECT ST_Transform(geom, 'EPSG:4326', 'EPSG:27700', always_xy := true) AS g
  FROM wind
)
SELECT name, operator, type, geom
FROM f
WHERE EXISTS (SELECT 1 FROM w WHERE ST_DWithin(f.g, w.g, 20000))`,
      geopandas: `fields = layers["fields"].query("status == 'PRODUCING'").to_crs(27700)
wind = layers["wind"].to_crs(27700)

near = gpd.sjoin(fields, wind[["geometry"]], predicate="dwithin", distance=20000)
result = fields.loc[near.index.unique(), ["name", "operator", "type", "geometry"]]`,
    },
    answer: (r) =>
      `${r.count} producing oil and gas fields sit within 20 km of an offshore wind site, shown in orange${r.count ? `, including ${names(r)}` : ""}. Turf measures on the sphere while DuckDB and GeoPandas measure in British National Grid, so a field sitting right on the 20 km line could fall either side.`,
  },
  {
    question: "Which active platforms have the most wells within 1 km?",
    title: "Wells within 1 km of each active platform",
    code: {
      turf: `const wells = layers.wells.features.map((f) => f.geometry.coordinates);

const rows = layers.platforms.features
  .filter((p) => p.properties.status === "ACTIVE")
  .map((p) => {
    const [x, y] = p.geometry.coordinates;
    let n = 0;
    for (const c of wells) {
      if (Math.abs(c[1] - y) > 0.01 || Math.abs(c[0] - x) > 0.02) continue; // quick box check
      if (turf.distance(p, turf.point(c), { units: "kilometers" }) <= 1) n++;
    }
    return { platform: p.properties.name, operator: p.properties.operator, wells: n };
  });

return rows.sort((a, b) => b.wells - a.wells).slice(0, 10);`,
      duckdb: `SELECT p.name AS platform, p.operator, count(*) AS wells
FROM platforms p
JOIN wells w ON ST_Distance_Sphere(p.geom, w.geom) <= 1000
WHERE p.status = 'ACTIVE'
GROUP BY ALL
ORDER BY wells DESC
LIMIT 10`,
      geopandas: `plats = layers["platforms"].query("status == 'ACTIVE'").to_crs(27700)
wells = layers["wells"].to_crs(27700)

j = gpd.sjoin(plats, wells[["geometry"]], predicate="dwithin", distance=1000)
result = (j.groupby(["name", "operator"]).size().rename("wells")
           .sort_values(ascending=False).head(10)
           .reset_index().rename(columns={"name": "platform"}))`,
    },
    answer: (r) => {
      const top = r.rows && r.rows[0];
      return top
        ? `${top.platform} (${top.operator}) has the most, with ${top.wells} wellbores within 1 km. The table shows the top ten. Each sidetrack counts as its own wellbore.`
        : "No results.";
    },
  },
  {
    question: "Which operators have drilled the most wells since 2010?",
    title: "Wells spudded since 2010, by operator",
    code: {
      turf: `const counts = {};
for (const { properties: p } of layers.wells.features) {
  if (p.spud_year >= 2010 && p.operator) counts[p.operator] = (counts[p.operator] || 0) + 1;
}
return Object.entries(counts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
  .map(([operator, wells]) => ({ operator, wells }));`,
      duckdb: `SELECT operator, count(*) AS wells
FROM wells
WHERE spud_year >= 2010 AND operator IS NOT NULL
GROUP BY operator
ORDER BY wells DESC
LIMIT 10`,
      geopandas: `w = layers["wells"]
w = w[(w.spud_year >= 2010) & w.operator.notna()]

result = (w.groupby("operator").size().rename("wells")
           .sort_values(ascending=False).head(10).reset_index())`,
    },
    answer: (r) => {
      const top = r.rows && r.rows[0];
      return top
        ? `${top.operator} leads with ${top.wells} wellbores spudded since 2010. That one isn't really spatial: any engine can count, which is part of the point.`
        : "No results.";
    },
  },
];
