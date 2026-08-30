"""Command line entry point: build track data if needed, then serve the globe."""

from __future__ import annotations

import argparse
import threading
import webbrowser
from pathlib import Path

import platformdirs

from . import __version__, tracks
from .server import run


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="strava-globe",
        description="Your entire Strava history as glowing tracks on a realistic 3D Earth.",
        epilog="Get your export at strava.com: Settings -> My Account -> "
               "Download or Delete Your Account -> Request Your Archive.",
    )
    parser.add_argument(
        "export", nargs="?", type=Path,
        help="path to your Strava export (.zip or extracted folder); omit to reuse the last build",
    )
    parser.add_argument("--port", type=int, default=8933, help="port to serve on (default: 8933)")
    parser.add_argument("--no-browser", action="store_true", help="don't open the browser")
    parser.add_argument(
        "--data-dir", type=Path,
        default=Path(platformdirs.user_data_dir("strava-globe")),
        help="where the generated track data lives (default: %(default)s)",
    )
    parser.add_argument("--version", action="version", version=f"strava-globe {__version__}")
    args = parser.parse_args(argv)

    data_file = args.data_dir / "activities.json"
    if args.export:
        tracks.build(args.export.expanduser(), data_file)
    elif not data_file.exists():
        parser.error("no track data yet — pass the path to your Strava export zip (see --help)")

    def ready(url: str) -> None:
        print(f"Strava Globe -> {url}   (Ctrl+C to stop)")
        if not args.no_browser:
            threading.Timer(0.4, webbrowser.open, [url]).start()

    run(args.port, data_file, ready)


if __name__ == "__main__":
    main()
