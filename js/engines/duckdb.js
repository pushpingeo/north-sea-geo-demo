import { CONFIG } from "../config.js";
import { normalise } from "../results.js";

let duckdb; // the module, imported on first use

export const duckdbEngine = {
  id: "duckdb",
  label: "DuckDB Spatial",
  language: "sql",
  blurb: "SQL, in-browser database (~15 MB first load)",

  guide: `Write ONE DuckDB SQL query (the spatial extension is loaded). No trailing semicolon needed.
Each layer is a table named by its layer id, with its attribute columns plus \`geom\` (GEOMETRY, WGS84, x = longitude, y = latitude; geometry_always_xy is on).
To draw results on the map, return a GEOMETRY column named \`geom\`. Otherwise the result is shown as a table.
For metres, project to British National Grid: ST_Transform(geom, 'EPSG:4326', 'EPSG:27700', always_xy := true).
For point-to-point great-circle distance in metres you can use ST_Distance_Sphere(a, b).
Use LIMIT on large outputs. Quote column names that clash with SQL keywords.`,

  async load(layers, onStatus = () => {}) {
    onStatus("Loading DuckDB (WebAssembly)...");
    const v = CONFIG.versions.duckdb;
    duckdb = await import(`https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${v}/+esm`);
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
    );
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl));
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);
    const conn = await db.connect();

    onStatus("Loading spatial extension...");
    await conn.query("INSTALL spatial");
    await conn.query("LOAD spatial");
    try {
      await conn.query("SET geometry_always_xy = true");
    } catch {
      /* older spatial builds are always x/y already */
    }

    for (const [id, fc] of Object.entries(layers)) {
      onStatus(`Loading ${id} into DuckDB...`);
      // CSV rather than JSON: the CSV reader is built in, the JSON one is another download.
      await db.registerFileText(`${id}.csv`, toCsv(fc));
      await conn.query(
        `CREATE OR REPLACE TABLE "${id}" AS
         SELECT * EXCLUDE (__gj), ST_GeomFromGeoJSON(__gj) AS geom
         FROM read_csv('${id}.csv', header = true, sample_size = -1)`
      );
    }
    this.db = db;
    this.conn = conn;
  },

  async run(sql) {
    sql = sql.trim().replace(/;+\s*$/, "");
    const described = await this.conn.query(`DESCRIBE SELECT * FROM (${sql}) AS q`);
    const cols = described.toArray().map((r) => r.toJSON());
    const geomCol = cols.find(
      (c) => c.column_name === "geom" && String(c.column_type).startsWith("GEOMETRY")
    );

    if (geomCol) {
      const t = await this.conn.query(
        `SELECT * EXCLUDE (geom), ST_AsGeoJSON(geom) AS __gj FROM (${sql}) AS q LIMIT 5000`
      );
      const features = rows(t)
        .filter((r) => r.__gj)
        .map(({ __gj, ...props }) => ({
          type: "Feature",
          properties: props,
          geometry: typeof __gj === "string" ? JSON.parse(__gj) : __gj,
        }));
      return normalise({ type: "FeatureCollection", features });
    }

    const out = rows(await this.conn.query(`SELECT * FROM (${sql}) AS q LIMIT 1000`));
    if (out.length === 1 && Object.keys(out[0]).length === 1) {
      return normalise(Object.values(out[0])[0]);
    }
    return normalise(out);
  },
};

function toCsv(fc) {
  const cols = [];
  for (const f of fc.features) for (const k of Object.keys(f.properties || {})) if (!cols.includes(k)) cols.push(k);
  const cell = (v) =>
    v == null ? "" : typeof v === "string" ? `"${v.replace(/"/g, '""')}"` : String(v);
  const lines = [[...cols, "__gj"].join(",")];
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const p = f.properties || {};
    lines.push([...cols.map((c) => cell(p[c])), cell(JSON.stringify(f.geometry))].join(","));
  }
  return lines.join("\n");
}

function rows(arrowTable) {
  return arrowTable.toArray().map((r) => {
    const o = r.toJSON();
    for (const [k, v] of Object.entries(o)) o[k] = plain(v);
    return o;
  });
}

function plain(v) {
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Uint8Array) return "[binary]";
  if (v && typeof v === "object" && typeof v.toJSON === "function") return plain(v.toJSON());
  if (Array.isArray(v)) return v.map(plain);
  return v;
}
