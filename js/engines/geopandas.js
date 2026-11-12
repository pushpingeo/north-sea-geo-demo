import { CONFIG } from "../config.js";
import { normalise } from "../results.js";

const SETUP = `
import json, warnings
import pandas as pd
import geopandas as gpd
import shapely
import bng
warnings.filterwarnings("ignore")
bng.install()

def _load(text):
    out = {}
    for k, fc in json.loads(text).items():
        out[k] = gpd.GeoDataFrame.from_features(fc["features"], crs="EPSG:4326")
    return out

LAYERS = _load(_LAYER_JSON)
del _LAYER_JSON

def _run(code):
    ns = {"layers": {k: v.copy() for k, v in LAYERS.items()},
          "gpd": gpd, "pd": pd, "shapely": shapely, "json": json}
    exec(code, ns)
    if "result" not in ns:
        raise ValueError("Assign your answer to a variable called result")
    r = ns["result"]
    if isinstance(r, gpd.GeoSeries):
        r = gpd.GeoDataFrame(geometry=r)
    if isinstance(r, gpd.GeoDataFrame):
        if r.crs is not None and bng.epsg_of(r.crs) != 4326:
            r = r.to_crs(4326)
        return r.to_json(default=str)
    if isinstance(r, pd.Series):
        r = r.rename(r.name if r.name is not None else "value").reset_index()
    if isinstance(r, pd.DataFrame):
        r = r.select_dtypes(exclude=["geometry"])
        return r.head(1000).to_json(orient="records", default_handler=str)
    if hasattr(r, "item"):
        r = r.item()
    return json.dumps(r, default=str)
`;

export const geopandasEngine = {
  id: "geopandas",
  label: "GeoPandas",
  language: "python",
  blurb: "Python in the browser via Pyodide (~30 MB first load)",

  guide: `Write Python (GeoPandas 1.x, pandas, shapely 2).
In scope: \`layers\` (dict of GeoDataFrames keyed by layer id, CRS EPSG:4326), \`gpd\`, \`pd\`, \`shapely\`.
Assign the final answer to a variable called \`result\`: a GeoDataFrame (drawn on the map), a DataFrame (table) or a single value.
For metres, project first: gdf.to_crs(27700) (British National Grid). Areas from .area are then in square metres.
to_crs supports only EPSG:4326, 27700 and 3857 here (no estimate_utm_crs).
No file or network access.`,

  async load(layers, onStatus = () => {}) {
    onStatus("Loading Python (Pyodide)...");
    const v = CONFIG.versions.pyodide;
    const { loadPyodide } = await import(`https://cdn.jsdelivr.net/pyodide/v${v}/full/pyodide.mjs`);
    const py = await loadPyodide({ indexURL: `https://cdn.jsdelivr.net/pyodide/v${v}/full/` });
    onStatus("Installing GeoPandas...");
    await py.loadPackage(["geopandas"]);
    const helper = await (await fetch(new URL("./bng.py", import.meta.url))).text();
    py.FS.writeFile("/home/pyodide/bng.py", helper);
    onStatus("Loading layers into GeoPandas...");
    py.globals.set("_LAYER_JSON", JSON.stringify(layers));
    await py.runPythonAsync(SETUP);
    this.py = py;
  },

  async run(code) {
    if (!this.py) throw new Error("The Python engine is restarting. Try again.");
    const runner = this.py.globals.get("_run");
    try {
      const txt = runner(code);
      return normalise(JSON.parse(txt));
    } catch (e) {
      // Keep the Python error, drop the Pyodide plumbing above it.
      const msg = String(e.message || e);
      if (/fatal|null function/i.test(msg)) {
        // Pyodide can't recover from a crash inside a compiled library. Reload on next run.
        this.dead = true;
        this.py = null;
        throw new Error("The Python engine crashed inside a compiled library and will restart on the next run. " +
          "Avoid that operation (often a pyproj call other than to_crs).");
      }
      const lines = msg.trim().split("\n");
      const i = lines.findIndex((l) => l.includes('File "<string>"'));
      throw new Error(i >= 0 ? lines.slice(i).join("\n") : lines.slice(-4).join("\n"));
    } finally {
      if (!this.dead) runner.destroy();
    }
  },
};
