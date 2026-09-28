#!/usr/bin/env python3
"""Zero-dependency static server for the browser build (`npm run web`).

Serves the repo root so web/index.html can reach ../shared/* with plain
relative URLs, with .syx/.zpatch as application/octet-stream so patch-file
downloads behave.

Deliberately no Cross-Origin-Opener/Embedder-Policy headers: this app has
no cross-origin isolation needs (plain ES modules, same-origin fetch), and
COEP=require-corp would force the Google Fonts stylesheet to carry extra
headers it doesn't send.

WebMIDI (with the sysex this app needs) only works in a secure context:
http://localhost is treated as secure, so serve + open locally works, but
any LAN/remote hosting needs HTTPS. Only Chromium browsers (Chrome/Edge)
implement WebMIDI at all - Firefox/Safari show the page but Connect fails.
"""

import functools
import http.server
import os

PORT = int(os.environ.get("PORT", "8000"))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".syx": "application/octet-stream",
        ".zpatch": "application/octet-stream",
    }

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    handler = functools.partial(Handler, directory=ROOT)
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler) as httpd:
        print(f"Signal Chain (web) at http://localhost:{PORT}/web/index.html")
        print("Press Ctrl+C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
