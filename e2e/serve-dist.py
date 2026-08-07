"""
Serve frontend/dist with SPA fallback, for browser tests against a LOCAL build.

Needed because Vercel is not auto-deploying the user frontend right now, so a
test run against the deployed URL would exercise an old bundle and prove
nothing about the fix under test. `python3 -m http.server` is not a substitute:
it 404s on /verification, and the suite then reports failures that are entirely
the server's fault.

Run: python3 e2e/serve-dist.py   (from the repo root)
"""

import http.server
import os
import socketserver

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'frontend', 'dist')


class SpaHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        path = self.translate_path(self.path)
        # Any client-side route falls back to the app shell.
        if not os.path.exists(path) or os.path.isdir(path):
            self.path = '/index.html'
        return super().do_GET()

    def log_message(self, *args):
        pass


socketserver.TCPServer.allow_reuse_address = True

# PORT IS OVERRIDABLE so two journeys can run without colliding. Hardcoded
# 4173 meant a second suite silently reused whichever build the first had
# left serving - the stale-stack failure that has already cost debugging
# cycles here.
PORT = int(os.environ.get('APP_PORT', '4173'))
with socketserver.TCPServer(('127.0.0.1', PORT), SpaHandler) as httpd:
    httpd.serve_forever()
