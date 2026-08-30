"""Build the globe's track data from a Strava export (directory or .zip).

Reads activities.csv for metadata, decodes every referenced FIT/GPX track
(fitfast for FIT), splits tracks at GPS dropouts, simplifies each segment
with Ramer-Douglas-Peucker, tags each activity with its nearest city
(offline GeoNames lookup), extracts activity photos as local thumbnails,
and writes one compact JSON the web app loads.
"""

from __future__ import annotations

import csv
import gzip
import io
import json
import re
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import fitfast
import numpy as np
import reverse_geocoder
from PIL import Image, ImageOps
from simplification.cutil import simplify_coords

EPSILON_DEG = 5e-5  # RDP tolerance, ~5.5 m
GAP_SPLIT_M = 500.0  # split a track where consecutive fixes are further apart
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}  # export media can also hold videos
THUMB_PX, MEDIUM_PX = 288, 1280
MON = {m: i + 1 for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}
DATE_RE = re.compile(r"^([A-Za-z]{3}) (\d{1,2}), (\d{4})")


class Export:
    """Uniform file access over an extracted export directory or the raw zip."""

    def __init__(self, path: Path):
        self.zip = zipfile.ZipFile(path) if path.suffix == ".zip" else None
        self.root = path

    def read(self, rel: str) -> bytes:
        if self.zip:
            return self.zip.read(rel)
        return (self.root / rel).read_bytes()


def parse_date(s: str) -> tuple[str, int]:
    m = DATE_RE.match(s)
    if not m:
        return "", 0
    mon, day, year = MON[m.group(1)], int(m.group(2)), int(m.group(3))
    return f"{year:04d}-{mon:02d}-{day:02d}", year


def latlon_from_fit(data: bytes) -> np.ndarray | None:
    cols = fitfast.records(data)
    if "position_lat" not in cols or "position_long" not in cols:
        return None
    lat, lon = cols["position_lat"], cols["position_long"]
    ok = ~(np.isnan(lat) | np.isnan(lon))
    if ok.sum() < 2:
        return None
    return np.column_stack([lon[ok], lat[ok]])


def latlon_from_gpx(data: bytes) -> np.ndarray | None:
    pts = []
    for _, el in ET.iterparse(io.BytesIO(data)):
        if el.tag.endswith("}trkpt") or el.tag == "trkpt":
            pts.append((float(el.attrib["lon"]), float(el.attrib["lat"])))
            el.clear()
    return np.array(pts) if len(pts) >= 2 else None


def step_meters(coords: np.ndarray) -> np.ndarray:
    """Approximate distance between consecutive [lon, lat] fixes (equirectangular)."""
    rad = np.radians(coords)
    d = np.diff(rad, axis=0)
    dx = d[:, 0] * np.cos((rad[:-1, 1] + rad[1:, 1]) / 2)
    return 6371000.0 * np.hypot(dx, d[:, 1])


def segments(coords: np.ndarray) -> list[np.ndarray]:
    breaks = np.flatnonzero(step_meters(coords) > GAP_SPLIT_M)
    return [s for s in np.split(coords, breaks + 1) if len(s) >= 2]


def photo_captions(export: Export) -> dict[str, str]:
    try:
        rows = list(csv.reader(io.StringIO(export.read("media.csv").decode("utf-8"))))
    except Exception:
        return {}
    return {r[0]: r[1] if len(r) > 1 else "" for r in rows[1:] if r}


def process_photo(export: Export, rel: str, photos_dir: Path) -> str:
    """Write t_<stem>.jpg and m_<stem>.jpg thumbnails; return the stem."""
    stem = Path(rel).stem
    thumb, medium = photos_dir / f"t_{stem}.jpg", photos_dir / f"m_{stem}.jpg"
    if thumb.exists() and medium.exists():
        return stem
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(export.read(rel)))).convert("RGB")
    for target, px in ((medium, MEDIUM_PX), (thumb, THUMB_PX)):
        scaled = img.copy()
        scaled.thumbnail((px, px))
        scaled.save(target, "JPEG", quality=82)
    return stem


def build(export_path: Path, out: Path) -> None:
    """Process the export at export_path and write the track JSON to out."""
    export = Export(export_path)

    rows = list(csv.reader(io.StringIO(export.read("activities.csv").decode("utf-8"))))
    hdr = rows[0]
    idx: dict[str, int] = {}
    for i, name in enumerate(hdr):
        idx.setdefault(name, i)  # first occurrence wins (first Distance column is km)
    col = lambda row, name: row[idx[name]] if idx[name] < len(row) else ""

    captions = photo_captions(export)
    photos_dir = out.parent / "photos"
    activities, centers, skipped, failed = [], [], 0, []
    raw_pts = kept_pts = photo_ok = photo_bad = 0
    for row in rows[1:]:
        fname = col(row, "Filename")
        if not fname:
            skipped += 1
            continue
        try:
            data = export.read(fname)
            if fname.endswith(".gz"):
                data = gzip.decompress(data)
            kind = fname.removesuffix(".gz").rsplit(".", 1)[-1]
            coords = latlon_from_fit(data) if kind == "fit" else latlon_from_gpx(data) if kind == "gpx" else None
        except Exception as e:
            failed.append((fname, repr(e)))
            continue
        if coords is None:
            skipped += 1  # no GPS (treadmill, pool swim, strength...)
            continue

        raw_pts += len(coords)
        try:
            km = float(col(row, "Distance").replace(",", ""))
        except ValueError:
            km = float(np.sum(step_meters(coords))) / 1000.0

        segs = []
        for seg in segments(coords):
            simple = simplify_coords(seg, EPSILON_DEG)
            kept_pts += len(simple)
            segs.append([[round(float(x), 5), round(float(y), 5)] for x, y in simple])
        if not segs:
            skipped += 1
            continue

        photos = []
        if "Media" in idx:
            for rel in filter(None, col(row, "Media").split("|")):
                if Path(rel).suffix.lower() not in IMAGE_EXTS:
                    continue
                try:
                    photos_dir.mkdir(parents=True, exist_ok=True)
                    photos.append([process_photo(export, rel, photos_dir), captions.get(rel, "")])
                    photo_ok += 1
                except Exception:
                    photo_bad += 1

        date, year = parse_date(col(row, "Activity Date"))
        centers.append((float(np.median(coords[:, 1])), float(np.median(coords[:, 0]))))
        activities.append({
            "n": col(row, "Activity Name"),
            "t": col(row, "Activity Type"),
            "d": date,
            "y": year,
            "km": round(km, 2),
            "s": segs,
            **({"p": photos} if photos else {}),
        })

    # Offline reverse geocoding (GeoNames): nearest city name + country per activity
    if activities:
        for a, place in zip(activities, reverse_geocoder.search(centers, mode=1)):
            a["c"] = place["name"]
            a["cc"] = place["cc"]

    activities.sort(key=lambda a: a["d"])
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as f:
        json.dump({"activities": activities}, f, ensure_ascii=False, separators=(",", ":"))

    types: dict[str, int] = {}
    for a in activities:
        types[a["t"]] = types.get(a["t"], 0) + 1
    print(f"tracks: {len(activities)}  (skipped, no GPS/no file: {skipped}, failed: {len(failed)})")
    print(f"points: {raw_pts:,} -> {kept_pts:,} after simplification")
    print(f"types:  {types}")
    print(f"total:  {sum(a['km'] for a in activities):,.0f} km")
    if photo_ok or photo_bad:
        print(f"photos: {photo_ok} thumbnailed -> {photos_dir}  (failed/skipped: {photo_bad})")
    print(f"wrote:  {out}  ({out.stat().st_size / 1e6:.1f} MB)")
    for fname, err in failed[:10]:
        print(f"  FAILED {fname}: {err}")
