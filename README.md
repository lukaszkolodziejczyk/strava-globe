# Strava Globe

Your entire Strava history as glowing tracks on a realistic 3D Earth.

![Every activity on one globe](https://raw.githubusercontent.com/lukaszkolodziejczyk/strava-globe/main/docs/hero.jpg)

Point it at the export zip Strava gives you, and you get a private, local globe
(CesiumJS + satellite imagery) you can spin, zoom from orbit down to street
level, and fly around:

- **Every GPS track** drawn on the globe, colored by activity type, with
  hover tooltips (name · date · distance · place) — click a track to fly to it.
- **▶ Tour mode**: your activities are clustered into places, named via offline
  reverse geocoding, ordered by first visit — and the camera flies through your
  travel history stop by stop, with a card per place and a closing summary.
- **Filters** by activity type and year, satellite or street basemap, and an
  idle globe spin until you grab it.
- **No accounts, no API keys, no upload.** Your tracks never leave your machine.

![Flight tour flying between places](https://raw.githubusercontent.com/lukaszkolodziejczyk/strava-globe/main/docs/tour.gif)

*The tour taking off: home base → Poznań → Vienna, the first three of 41 stops.*

| From orbit to city… | …to street level |
|---|---|
| ![A city's worth of tracks](https://raw.githubusercontent.com/lukaszkolodziejczyk/strava-globe/main/docs/city.jpg) | ![Runs along a coastline](https://raw.githubusercontent.com/lukaszkolodziejczyk/strava-globe/main/docs/street.jpg) |

## Quickstart

1. Request your archive on strava.com: *Settings → My Account → Download or
   Delete Your Account → Request Your Archive* (the zip arrives by email).
2. Run (with [uv](https://docs.astral.sh/uv/), no install needed):

   ```bash
   uvx strava-globe ~/Downloads/export_12345678.zip
   ```

   or classically:

   ```bash
   pip install strava-globe
   strava-globe ~/Downloads/export_12345678.zip
   ```

The globe builds and opens at http://localhost:8933. Next time, plain
`uvx strava-globe` reuses the last build (the generated data lives in your
user data directory; `--port`, `--no-browser`, and `--data-dir` are available).

## How it works

The builder (`strava_globe/tracks.py`) reads `activities.csv` from the
export — zip or extracted folder — then for every activity file:

- decodes FIT with [fitfast](https://github.com/lukaszkolodziejczyk/fitfast)
  and GPX with a small XML parser (indoor activities without GPS are skipped),
- splits tracks at GPS dropouts (>500 m between fixes),
- simplifies each segment with Ramer-Douglas-Peucker (~5 m tolerance,
  [`simplification`](https://pypi.org/project/simplification/)),
- tags the activity with its nearest city and country — offline GeoNames
  lookup via [`reverse-geocoder`](https://pypi.org/project/reverse_geocoder/),
- and writes one compact `activities.json` (~1.7 MB for 725 tracks /
  1.9 M raw GPS points).

The web app (`strava_globe/web/`) is dependency-free: CesiumJS 1.131 from the
jsdelivr CDN, imagery streamed from Esri World Imagery (satellite) or
OpenStreetMap (streets), served by a stdlib static server with caching
disabled.

## Controls

| | |
|---|---|
| drag / scroll | spin / zoom the globe |
| hover a track | tooltip with name, date, distance, place |
| click a track | fly to that activity |
| `T` or **▶ Tour** | replay your travels place by place |
| space · ⏮ ⏭ / arrows · Esc | pause · previous/next stop · end tour |
| ⌂ Home | back to the full globe |

## Privacy

Your GPS data stays local: the generated `activities.json` lives in your user
data directory (never in this repo or the package), and the app talks only to
the CDN and the map tile servers (which necessarily see which map areas you
view, as with any online map).

## Notes

- Rendering quirk: `msaaSamples = 1` and `dynamicAtmosphereLighting = false`
  are deliberate — MSAA and sun-driven atmosphere shading render a black globe
  on software-GL stacks (e.g. headless/embedded Chromium).
- Tile imagery: Esri World Imagery is used under its
  [terms](https://www.esri.com/en-us/legal/terms/full-master-agreement) for
  personal/non-commercial viewing; OpenStreetMap tiles per the
  [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/).
- Not affiliated with or endorsed by Strava, Garmin, Esri, or OpenStreetMap.
  "Strava" is used descriptively: the input is the data export Strava provides
  to its users.

## Development

```bash
git clone https://github.com/lukaszkolodziejczyk/strava-globe
cd strava-globe
uv run strava-globe path/to/export.zip
```

Releases: push a `v*` tag — GitHub Actions builds and publishes to PyPI via
trusted publishing (`.github/workflows/release.yml`).

## License

[BSD 3-Clause](LICENSE). Place names derived from
[GeoNames](https://www.geonames.org/) data (CC-BY 4.0) via `reverse-geocoder`.
