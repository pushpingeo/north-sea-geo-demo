import { CONFIG } from "../config.js";
import { normalise } from "../results.js";
import { loadScript } from "./util.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export const turfEngine = {
  id: "turf",
  label: "Turf.js",
  language: "javascript",
  blurb: "JavaScript, runs instantly in the page",

  guide: `Write the BODY of an async JavaScript function (no function wrapper).
In scope:
- \`layers\`: object of GeoJSON FeatureCollections keyed by layer id (WGS84, [lon, lat]).
- \`turf\`: Turf.js v7 (e.g. turf.buffer, turf.booleanPointInPolygon, turf.distance, turf.length, turf.area, turf.pointsWithinPolygon, turf.nearestPoint).
\`return\` one of: a FeatureCollection (drawn on the map), an array of plain objects (shown as a table), or a single value.
Turf distances are in kilometres by default; turf.area returns square metres.
No fetch, no DOM, no imports.`,

  async load(layers) {
    await loadScript(`https://cdn.jsdelivr.net/npm/@turf/turf@${CONFIG.versions.turf}/turf.min.js`);
    this.layers = layers;
  },

  async run(code) {
    const fn = new AsyncFunction("layers", "turf", '"use strict";\n' + code);
    // Fresh copy each run so generated code can't damage the source layers.
    const out = await fn(structuredClone(this.layers), window.turf);
    return normalise(out);
  },
};
