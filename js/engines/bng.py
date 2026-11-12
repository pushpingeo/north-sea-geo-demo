"""Coordinate transforms for the in-browser GeoPandas engine, without pyproj.

pyproj's transform calls crash inside Pyodide in Chrome (it works under Node),
so GeoDataFrame.to_crs is replaced with plain numpy versions of:

  EPSG:4326  <->  EPSG:27700  (Ordnance Survey: Helmert datum shift + Transverse Mercator)
  EPSG:4326  <->  EPSG:3857   (Web Mercator)

Checked against pyproj: the projection step matches to the millimetre, and the full
WGS84 -> BNG transform matches to the millimetre west of 2 degrees E. East of 2 degrees E
pyproj drops the datum shift (it's outside the EPSG transformation's area of use), so
positions differ by ~140 m there. This version applies the shift everywhere, which
avoids pyproj's jump at 2 degrees E. Distances and areas are what matter in the demo,
and those are unaffected. Not survey grade (no OSTN15 grid).
"""

import re

import numpy as np
import shapely
import geopandas as gpd
from pyproj import CRS

_RAD = np.pi / 180.0
_SEC = _RAD / 3600.0

_WGS84_ELL = (6378137.000, 6356752.3141)
_AIRY_ELL = (6377563.396, 6356256.909)
# WGS84 -> OSGB36 Helmert (OS "A guide to coordinate systems in Great Britain")
_H = dict(tx=-446.448, ty=125.157, tz=-542.060, s=20.4894e-6,
          rx=-0.1502 * _SEC, ry=-0.2470 * _SEC, rz=-0.8421 * _SEC)
# National Grid projection
_F0, _LAT0, _LON0, _N0, _E0 = 0.9996012717, 49 * _RAD, -2 * _RAD, -100000.0, 400000.0


def _geo_to_cart(lat, lon, ell):
    a, b = ell
    e2 = 1 - (b * b) / (a * a)
    nu = a / np.sqrt(1 - e2 * np.sin(lat) ** 2)
    return (nu * np.cos(lat) * np.cos(lon), nu * np.cos(lat) * np.sin(lon),
            (1 - e2) * nu * np.sin(lat))


def _cart_to_geo(x, y, z, ell):
    a, b = ell
    e2 = 1 - (b * b) / (a * a)
    p = np.sqrt(x * x + y * y)
    lat = np.arctan2(z, p * (1 - e2))
    for _ in range(6):
        nu = a / np.sqrt(1 - e2 * np.sin(lat) ** 2)
        lat = np.arctan2(z + e2 * nu * np.sin(lat), p)
    return lat, np.arctan2(y, x)


def _helmert(x, y, z, sign):
    h = {k: v * sign for k, v in _H.items()}
    s1 = 1 + h["s"]
    return (h["tx"] + s1 * x - h["rz"] * y + h["ry"] * z,
            h["ty"] + h["rz"] * x + s1 * y - h["rx"] * z,
            h["tz"] - h["ry"] * x + h["rx"] * y + s1 * z)


def _kruger(ell):
    a, b = ell
    f = (a - b) / a
    n = f / (2 - f)
    e = 2 * np.sqrt(n) / (1 + n)
    A = a / (1 + n) * (1 + n ** 2 / 4 + n ** 4 / 64)
    al = (n / 2 - 2 * n ** 2 / 3 + 5 * n ** 3 / 16 + 41 * n ** 4 / 180,
          13 * n ** 2 / 48 - 3 * n ** 3 / 5 + 557 * n ** 4 / 1440,
          61 * n ** 3 / 240 - 103 * n ** 4 / 140,
          49561 * n ** 4 / 161280)
    be = (n / 2 - 2 * n ** 2 / 3 + 37 * n ** 3 / 96 - n ** 4 / 360,
          n ** 2 / 48 + n ** 3 / 15 - 437 * n ** 4 / 1440,
          17 * n ** 3 / 480 - 37 * n ** 4 / 840,
          4397 * n ** 4 / 161280)
    de = (2 * n - 2 * n ** 2 / 3 - 2 * n ** 3 + 116 * n ** 4 / 45,
          7 * n ** 2 / 3 - 8 * n ** 3 / 5 - 227 * n ** 4 / 45,
          56 * n ** 3 / 15 - 136 * n ** 4 / 35,
          4279 * n ** 4 / 630)
    return e, A, al, be, de


# Exact-to-millimetres Transverse Mercator (Krueger series, as used by PROJ's etmerc),
# on the Airy 1830 ellipsoid with the National Grid origin.
_E_AIRY, _A_AIRY, _AL, _BE, _DE = _kruger(_AIRY_ELL)


def _xi_eta(phi, dl):
    t = np.sinh(np.arctanh(np.sin(phi)) - _E_AIRY * np.arctanh(_E_AIRY * np.sin(phi)))
    return np.arctan2(t, np.cos(dl)), np.arctanh(np.sin(dl) / np.sqrt(1 + t * t))


def _northing_origin():
    xi0, _ = _xi_eta(np.array(_LAT0), np.array(0.0))
    return _A_AIRY * (xi0 + sum(a * np.sin(2 * (j + 1) * xi0) for j, a in enumerate(_AL)))


_M0 = _northing_origin()


def wgs84_to_bng(lon, lat):
    # datum shift WGS84 -> OSGB36 (heights taken as 0)
    x, y, z = _geo_to_cart(lat * _RAD, lon * _RAD, _WGS84_ELL)
    phi, lam = _cart_to_geo(*_helmert(x, y, z, 1), _AIRY_ELL)
    xi, eta = _xi_eta(phi, lam - _LON0)
    sx = xi + sum(a * np.sin(2 * (j + 1) * xi) * np.cosh(2 * (j + 1) * eta) for j, a in enumerate(_AL))
    se = eta + sum(a * np.cos(2 * (j + 1) * xi) * np.sinh(2 * (j + 1) * eta) for j, a in enumerate(_AL))
    return _E0 + _F0 * _A_AIRY * se, _N0 + _F0 * (_A_AIRY * sx - _M0)


def bng_to_wgs84(E, N):
    xi = (N - _N0 + _F0 * _M0) / (_F0 * _A_AIRY)
    eta = (E - _E0) / (_F0 * _A_AIRY)
    xp = xi - sum(b * np.sin(2 * (j + 1) * xi) * np.cosh(2 * (j + 1) * eta) for j, b in enumerate(_BE))
    ep = eta - sum(b * np.cos(2 * (j + 1) * xi) * np.sinh(2 * (j + 1) * eta) for j, b in enumerate(_BE))
    chi = np.arcsin(np.sin(xp) / np.cosh(ep))
    phi = chi + sum(d * np.sin(2 * (j + 1) * chi) for j, d in enumerate(_DE))
    lam = _LON0 + np.arctan2(np.sinh(ep), np.cos(xp))
    # datum shift OSGB36 -> WGS84
    x, y, z = _geo_to_cart(phi, lam, _AIRY_ELL)
    lat, lon = _cart_to_geo(*_helmert(x, y, z, -1), _WGS84_ELL)
    return lon / _RAD, lat / _RAD


_R = 6378137.0


def wgs84_to_web(lon, lat):
    return _R * lon * _RAD, _R * np.log(np.tan(np.pi / 4 + lat * _RAD / 2))


def web_to_wgs84(x, y):
    return x / _R / _RAD, (2 * np.arctan(np.exp(y / _R)) - np.pi / 2) / _RAD


_KNOWN = {4326: CRS.from_epsg(4326), 27700: CRS.from_epsg(27700), 3857: CRS.from_epsg(3857)}
_STEPS = {
    (4326, 27700): [wgs84_to_bng], (27700, 4326): [bng_to_wgs84],
    (4326, 3857): [wgs84_to_web], (3857, 4326): [web_to_wgs84],
    (27700, 3857): [bng_to_wgs84, wgs84_to_web], (3857, 27700): [web_to_wgs84, wgs84_to_bng],
}


def epsg_of(crs):
    """EPSG code from a CRS-like value, by reading text only.

    Comparing or exporting pyproj CRS objects can call into PROJ, which is what
    crashes in the browser, so this never does.
    """
    if crs is None:
        return None
    if isinstance(crs, (int, np.integer)):
        return int(crs)
    text = crs.srs if isinstance(crs, CRS) else str(crs)
    text = text.strip().upper()
    if text in ("OGC:CRS84", "WGS84", "WGS 84"):
        return 4326
    m = re.search(r"EPSG:+(\d+)", text)
    return int(m.group(1)) if m else None


def _target(crs, epsg):
    code = epsg_of(crs if crs is not None else epsg)
    if code not in _KNOWN:
        raise ValueError(
            "In this browser build to_crs supports EPSG:4326, EPSG:27700 (British National Grid) "
            "and EPSG:3857 only. Use 27700 for metres.")
    return code


def _transform_array(geoms, src, dst):
    steps = _STEPS[(src, dst)]

    def fn(xy):
        x, y = xy[:, 0], xy[:, 1]
        for step in steps:
            x, y = step(x, y)
        return np.column_stack([x, y])

    return shapely.transform(geoms, fn)


def _geoseries_to_crs(self, crs=None, epsg=None):
    if self.crs is None:
        raise ValueError("Cannot transform naive geometries. Set a CRS first.")
    src, dst = epsg_of(self.crs), _target(crs, epsg)
    if src not in _KNOWN:
        raise ValueError("Unsupported source CRS in this browser build.")
    if src == dst:
        return self.copy()
    arr = _transform_array(np.asarray(self.values, dtype=object), src, dst)
    return gpd.GeoSeries(arr, index=self.index, crs=_KNOWN[dst], name=self.name)


def _geodataframe_to_crs(self, crs=None, epsg=None, inplace=False):
    gname = self.geometry.name
    gs = _geoseries_to_crs(self.geometry, crs, epsg)
    df = self.copy()
    df[gname] = np.asarray(gs.values, dtype=object)
    df = gpd.GeoDataFrame(df, geometry=gname, crs=gs.crs)
    if inplace:
        self.__dict__.update(df.__dict__)
        return None
    return df


def _no_utm(self, *a, **k):
    raise ValueError("estimate_utm_crs isn't available in this browser build. Use to_crs(27700).")


def install():
    gpd.GeoSeries.to_crs = _geoseries_to_crs
    gpd.GeoDataFrame.to_crs = _geodataframe_to_crs
    gpd.GeoSeries.estimate_utm_crs = _no_utm
    gpd.GeoDataFrame.estimate_utm_crs = _no_utm
