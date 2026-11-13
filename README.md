# One question, three engines

A map of UK North Sea energy data with a question box on top. Ask something in plain English and:

1. Claude turns it into a precise **spec**: which layers, exact filters, thresholds, what to return.
2. Claude then implements that spec three times, in **Turf.js**, **DuckDB Spatial** and **GeoPandas**, all at once. The code runs in your browser.
3. Each engine gets its own tab showing its code, timing and answer, and the map shows its result.
4. **Compare** puts all three on the map as nested rings and lists any disagreements in red.

The point: once AI is the interface, the tool doing the heavy lifting becomes a choice, not a lock-in. The spec step matters because without it Claude might read "near" as 10 km for one engine and 20 km for another. With it, any difference left over comes from the engines themselves. Usually they agree. Sometimes they don't, and that's the interesting part: on acreage, for example, Turf measures on the sphere and the others on British National Grid, so the totals differ by about half a percent.

Everything runs client-side on GitHub Pages. The only server is a small Cloudflare Worker that holds the Claude API key.

## Run it locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Without a Claude connection it runs in **examples mode**: the five example questions run pre-written code on all three engines, labelled as such. Click ⚙ to paste your own API key and ask live.

## Put it on GitHub Pages

1. Create a repo (e.g. `pushpingeo/north-sea-geo-demo`) and push this folder to it.
2. Repo **Settings → Pages**: deploy from the `main` branch, root folder.
3. It'll be at `https://pushpingeo.github.io/north-sea-geo-demo/`.

## Connect Claude (about 15 minutes)

Your claude.ai subscription doesn't include API access, so this needs a Claude Console account. With Haiku 5.5, a question (spec plus three engines) costs around a penny.

1. **Get a key.** Sign up at [platform.claude.com](https://platform.claude.com), add a few pounds of credit, create an API key, and **set a monthly spend limit** (e.g. $10) in the Console's limits settings. The limit is your real safety net.
2. **Deploy the Worker** (needs a free Cloudflare account and Node):
   ```bash
   cd worker
   npx wrangler login
   npx wrangler kv namespace create LIMITS     # paste the id into wrangler.toml
   npx wrangler secret put ANTHROPIC_API_KEY   # paste your key
   npx wrangler deploy                         # prints your worker URL
   ```
   In `wrangler.toml`, set `ALLOWED_ORIGINS` to your Pages address (`https://pushpingeo.github.io`). Add `,http://localhost:8000` while testing.
3. **Point the site at it.** Put the worker URL in `js/config.js` as `proxyUrl` and push.

The Worker only accepts requests from your site, pins the model to Haiku, caps response length at `MAX_TOKENS` (8,000, enough for Haiku to think and then write code), and limits each visitor to 200 requests a day (a question is roughly 7 to 10 requests, so about 20 to 25 questions) and everyone together to 5,000. If you set the Worker up in the Cloudflare dashboard, change `PER_VISITOR_DAILY` and `TOTAL_DAILY` there. When a limit is hit, the page drops back to examples mode instead of breaking, and an example clicked at that moment runs its pre-written version.

## How it fits together

```
index.html          question bar, map (MapLibre), engine tabs
js/app.js           spec step, three parallel Claude tool loops, map, UI
js/compare.js       compares the three results (features, tables or single values)
js/claude.js        talks to the Worker (or Anthropic directly with a visitor's own key)
js/engines/*.js     one file per engine: load(), run(code), and a short guide for Claude
js/engines/bng.py   WGS84 <-> British National Grid for GeoPandas in the browser (see below)
js/examples.js      five industry questions, each with a spec and pre-written code for every engine
data/               GeoJSON + layers.json, built by scripts/prepare_data.py
worker/             Cloudflare Worker that holds the API key
```

First, one Claude call with no tools writes the spec. Then each engine runs its own conversation with Claude. Each has a single tool, `run_analysis(code)`, and a system prompt saying which engine it is, how that engine wants its code (a JS function body, one SQL query, or Python that sets `result`), and the schema of every layer. Every engine returns the same shape: features for the map, a table, or a single value. Claude only sees a short summary of each result; the visitor sees all of it. Follow-up questions work because the spec step and each engine keep their own history.

Compare matches features by an identifying property (well, name and so on) or by location. It treats numbers within 0.1% as the same, within 2% as "close" (shown in amber, usually down to how each engine measures), and anything bigger or missing as a disagreement (red).

**Adding an engine** is one file with `load(layers)`, `run(code)` and a `guide` string, plus one line in `app.js` and a tab in `index.html`. Obvious next candidates: [Apache Sedona](https://sedona.apache.org/) behind an API, PostGIS via a small server, or geo-arrow / [GeoRust](https://georust.org/) in WebAssembly.

## Data

| Layer | Source | Notes |
|---|---|---|
| Petroleum licences | NSTA | Current offshore production licences |
| Oil & gas fields | NSTA | Field outlines |
| Offshore wind sites | Crown Estate Scotland, The Crown Estate | `capacity_mw` only for Scottish sites |
| Pipelines | NSTA | 5 km and longer only (933 of ~9,000), simplified |
| Platforms & FPSOs | NSTA | Surface installations |
| Wells | NSTA | Wellbore top holes; sidetracks share a location |

Refresh with `python3 scripts/prepare_data.py` (standard library only). Field names are renamed to plain snake_case so every engine sees the same columns. Check each publisher's licence terms before reusing the data. NSTA publishes its open data under the Open Government Licence.

## Things worth knowing

- **First load.** Turf is instant. On a desktop, DuckDB (about 15 MB, including its spatial extension from `extensions.duckdb.org`) and GeoPandas (about 30 MB, around 8 seconds) start loading in the background as soon as the map is up. On a phone they load on the first question. After that, everything's cached.
- **GeoPandas projections.** pyproj's transform calls crash Pyodide in Chrome (they work in Node). So in the browser, `to_crs` is replaced with a numpy implementation of WGS84 ↔ British National Grid (and Web Mercator) in `js/engines/bng.py`. It matches pyproj to the millimetre west of 2°E. East of 2°E pyproj drops the datum shift, because that's outside the EPSG transformation's area of use, so positions there differ by ~140 m. This version doesn't have that jump. If Python crashes anyway, the engine restarts itself on the next run.
- **Engines can disagree at the edges**, which is part of the story. Turf measures on the sphere; DuckDB and GeoPandas measure in British National Grid. On the acreage example, Turf has Serica at 2,887 km², DuckDB 2,901 and GeoPandas 2,903. Distance thresholds can flip a feature that sits right on the line. Pierce field, 20 km from a wind site and just east of 2°E, comes out at 19,869 m with pyproj's datum handling and 20,000 m with the consistent one.
- **Generated code runs in the visitor's own browser tab.** It can't reach the API key (that's in the Worker) or anyone else's session.

## What was tested

- All five examples agree on all three engines, apart from the expected acreage gaps. Checked with Turf in Node, DuckDB 1.5.4 (the version inside the DuckDB WASM build) and GeoPandas.
- In headless Chrome:
  - the full page in examples mode, on Turf and GeoPandas;
  - live mode end to end against a mocked Claude API: spec step, three engine loops in parallel, follow-up questions, map, Compare;
  - error handling, Python crash recovery, and a phone-sized layout.
- **Not tested in a browser:** DuckDB's spatial functions. The sandbox it was built in couldn't reach `extensions.duckdb.org`. Everything up to that point was tested, including loading all layers. Do one live check after deploying.
- The Worker has been checked live against the real Claude API.
