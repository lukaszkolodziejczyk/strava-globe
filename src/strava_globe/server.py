"""Local server: the packaged web app plus the user's generated track data."""

from __future__ import annotations

import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import as_file, files
from pathlib import Path
from typing import Callable


class Handler(SimpleHTTPRequestHandler):
    data_file: Path | None = None

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def translate_path(self, path: str) -> str:
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean == "/data/activities.json" and self.data_file is not None:
            return str(self.data_file)
        return super().translate_path(path)

    def log_message(self, *args):
        pass


def run(port: int, data_file: Path, ready: Callable[[str], None] | None = None) -> None:
    """Serve the app on 127.0.0.1:port until interrupted."""
    with as_file(files("strava_globe") / "web") as web_root:
        Handler.data_file = data_file
        handler = functools.partial(Handler, directory=str(web_root))
        httpd = ThreadingHTTPServer(("127.0.0.1", port), handler)
        if ready:
            ready(f"http://127.0.0.1:{port}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            httpd.server_close()
