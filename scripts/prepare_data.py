"""Download the demo layers from the NSTA and Crown Estate open data services
and cut them down to something a browser (and a chat model) can handle.

    python scripts/prepare_data.py

Writes data/*.geojson and data/layers.json. Re-run it to refresh the data.
Needs only the Python standard library.
"""

import json
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data"

NSTA = "https://services-eu1.arcgis.com/OZMfUznmLTnWccBc/ArcGIS/rest/services"
CES = "https://services3.arcgis.com/nGV4jiurzcahJ9LV/arcgis/rest/services"
TCE = "https://services2.arcgis.com/PZklK9Q45mfMFuZs/arcgis/rest/services"


def fetch(url, where="1=1", fields="*", offset=None):
    """Page through an ArcGIS FeatureServer layer as GeoJSON."""
    feats, start = [], 0
    while True:
        q = {
            "where": where,
            "outFields": fields,
            "outSR": 4326,
            "geometryPrecision": 5,
            "resultOffset": start,
            "resultRecordCount": 2000,
            "f": "geojson",
        }
        if offset:
            q["maxAllowableOffset"] = offset
        u = urllib.parse.quote(url, safe=":/()") + "/query?" + urllib.parse.urlencode(q)
        with urllib.request.urlopen(u, timeout=120) as r:
            page = json.load(r)
        got = page.get("features", [])
        feats += got
        print(f"  {url.split('/services/')[1][:60]}: {len(feats)}")
        if len(got) < 2000 and not page.get("properties", {}).get("exceededTransferLimit"):
            break
        start += len(got)
        time.sleep(0.3)
    return feats


def year(ms):
    if ms in (None, ""):
        return None
    if isinstance(ms, str):  # some layers store dates as "1975/04"
        return int(ms[:4]) if ms[:4].isdigit() else None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).year


def tidy(v):
    if isinstance(v, str):
        v = " ".join(v.split())
        return None if v in ("", "No Data Available", "Not Available") else v
    if isinstance(v, float):
        return round(v, 2)
    return v


def remap(feats, mapping):
    out = []
    for f in feats:
        if not f.get("geometry"):
            continue
        p = f["properties"]
        props = {}
        for new, old in mapping.items():
            props[new] = tidy(old(p) if callable(old) else p.get(old))
        out.append({"type": "Feature", "properties": props, "geometry": f["geometry"]})
    return out


def save(name, feats):
    fc = {"type": "FeatureCollection", "features": feats}
    path = OUT / f"{name}.geojson"
    path.write_text(json.dumps(fc, separators=(",", ":")))
    print(f"wrote {path.name}: {len(feats)} features, {path.stat().st_size / 1e6:.1f} MB")


def main():
    OUT.mkdir(exist_ok=True)

    wells = fetch(
        f"{NSTA}/UKCS_offshore_wellbore_top_holes_(WGS84)/FeatureServer/0",
        fields="WELLREGNO,ORIGINTENT,WELLOPSTAT,COMPLESTAT,SPUDDATE,TDOPGRP,TARGETFLD,"
        "WATDEP_M,TDTVDSSM,FLUIDTYPES,DEVTYPE",
    )
    save("wells", remap(wells, {
        "well": "WELLREGNO",
        "intent": "ORIGINTENT",
        "status": lambda p: (p.get("WELLOPSTAT") or "").replace("Decomissioned", "Decommissioned"),
        "well_type": "DEVTYPE",
        "spud_year": lambda p: year(p.get("SPUDDATE")),
        "operator": "TDOPGRP",
        "target_field": "TARGETFLD",
        "water_depth_m": "WATDEP_M",
        # A handful of source values are clearly not metres (e.g. 175,000); drop them.
        "depth_tvdss_m": lambda p: p.get("TDTVDSSM") if p.get("TDTVDSSM") is not None and 0 < p["TDTVDSSM"] < 12000 else None,
        "fluids": lambda p: ", ".join(x.strip() for x in (p.get("FLUIDTYPES") or "").split(",") if x.strip()) or None,
    }))

    platforms = fetch(
        f"{NSTA}/UKCS offshore infrastructure surface points WGS84/FeatureServer/1",
        fields="NAME,INF_TYPE,REP_GROUP,STATUS,PIPE_SYS,DESCRIPTIO",
    )
    save("platforms", remap(platforms, {
        "name": "NAME",
        "type": "INF_TYPE",
        "operator": "REP_GROUP",
        "status": "STATUS",
        "pipeline_system": "PIPE_SYS",
        "description": "DESCRIPTIO",
    }))

    # Only the longer pipelines: the full set is 9,000+ lines, mostly short in-field spools.
    pipes = fetch(
        f"{NSTA}/UKCS_offshore_infrastructure_pipeline_linear_(WGS84)/FeatureServer/1",
        where="INF_TYPE = 'PIPELINE' AND LENGTH_M >= 5000",
        fields="NSTAPIPNO,PIPE_NAME,FLUID,STATUS,DIAMETERMM,LENGTH_M,REP_GROUP,PIPE_SYS",
        offset=0.0005,
    )
    save("pipelines", remap(pipes, {
        "pipeline": "NSTAPIPNO",
        "name": "PIPE_NAME",
        "fluid": "FLUID",
        "status": "STATUS",
        "diameter_mm": "DIAMETERMM",
        "length_km": lambda p: round((p.get("LENGTH_M") or 0) / 1000, 1),
        "operator": "REP_GROUP",
        "pipeline_system": "PIPE_SYS",
    }))

    fields = fetch(
        f"{NSTA}/Offshore_hydrocarbon_fields_(WGS84)/FeatureServer/0",
        fields="FIELDNAME,FIELDTYPE,STATUS,DISC_DATE,PROD_DATE,CURR_OPER,DISC_WELL",
        offset=0.0005,
    )
    save("fields", remap(fields, {
        "name": "FIELDNAME",
        "type": "FIELDTYPE",
        "status": "STATUS",
        "discovered_year": lambda p: year(p.get("DISC_DATE")),
        "first_production_year": lambda p: year(p.get("PROD_DATE")),
        "operator": "CURR_OPER",
        "discovery_well": "DISC_WELL",
    }))

    lic = fetch(
        f"{NSTA}/UKCS offshore petroleum licences WGS84/FeatureServer/0",
        fields="LICREF,LICTYPE,LICSTATUS,SUBOPGRPS,LICORGGRP,BLOCKREF,CALC_KM2,LICSTARTDT,LICENDDT",
        offset=0.001,
    )
    save("licences", remap(lic, {
        "licence": "LICREF",
        "operator": "SUBOPGRPS",
        "holders": "LICORGGRP",
        "blocks": "BLOCKREF",
        "area_km2": "CALC_KM2",
        "start_year": lambda p: year(p.get("LICSTARTDT")),
    }))

    scot = fetch(f"{CES}/Offshore_Wind_Crown_Estate_Scotland/FeatureServer/0", offset=0.001)
    ewni = fetch(f"{TCE}/WindSite_EngWalNI_TheCrownEstate/FeatureServer/0", offset=0.001)
    wind = remap(scot, {
        "name": "Property_Description",
        "developer": "Tenant_Name",
        "phase": "Project_Phase",
        "capacity_mw": "Capacity_MW",
        "lease_round": "Lease_Type_Description",
        "region": lambda p: "Scotland",
    }) + remap(ewni, {
        "name": "Name_Prop",
        "developer": "Name_Ten",
        "phase": "Inf_Status",
        "capacity_mw": lambda p: None,
        "lease_round": "Wind_Round",
        "region": lambda p: "England, Wales & NI",
    })
    save("wind", wind)

    manifest = [
        {"id": "licences", "name": "Petroleum licences", "file": "licences.geojson",
         "color": "#7b6fa6", "hidden": True,
         "description": "Current (extant) UKCS offshore production licences (NSTA)."},
        {"id": "fields", "name": "Oil & gas fields", "file": "fields.geojson", "color": "#2f7d55",
         "description": "Offshore hydrocarbon field outlines (NSTA)."},
        {"id": "wind", "name": "Offshore wind sites", "file": "wind.geojson", "color": "#1c7ed6",
         "description": "Offshore wind lease and agreement areas (Crown Estate Scotland; The Crown Estate). capacity_mw is only given for Scottish sites."},
        {"id": "pipelines", "name": "Pipelines (5 km+)", "file": "pipelines.geojson", "color": "#495057",
         "description": "Offshore pipelines at least 5 km long, simplified (NSTA)."},
        {"id": "platforms", "name": "Platforms & FPSOs", "file": "platforms.geojson", "color": "#c92a2a",
         "description": "Offshore surface installations (NSTA)."},
        {"id": "wells", "name": "Wells", "file": "wells.geojson", "color": "#f08c00",
         "description": "Offshore wellbore top-hole locations (NSTA). One point per wellbore, so sidetracks share a location."},
    ]
    (OUT / "layers.json").write_text(json.dumps(manifest, indent=2))
    print("wrote layers.json")


if __name__ == "__main__":
    main()
