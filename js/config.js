// Edit these before you deploy.
export const CONFIG = {
  // URL of your Cloudflare Worker (see worker/README in the main README).
  // Leave empty and the demo runs in "examples" mode unless a visitor adds their own key.
  proxyUrl: "https://north-sea-geo-demo.robdunfey.workers.dev",

  model: "claude-haiku-5-5",
  maxTokens: 1500,
  maxToolRounds: 6,

  author: {
    name: "Rob Dunfey",
    url: "https://github.com/pushpingeo",
  },

  // Free basemap, no key needed.
  basemapStyle: "https://tiles.openfreemap.org/styles/positron",

  mapStart: { center: [1.5, 57.5], zoom: 4.6 },

  // Pinned library versions (all loaded from jsDelivr on demand).
  versions: {
    turf: "7.4.0",
    duckdb: "1.33.1-dev57.0",
    pyodide: "314.0.7",
  },
};
