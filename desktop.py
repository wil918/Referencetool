"""Spike: run the reference library in a native macOS window via pywebview,
instead of a browser tab.

This is not packaging and not an installer -- it exists to find out what
breaks under WKWebView. See DESKTOP_SPIKE.md for the results.

Run with:
    python desktop.py
(after `pip install -r requirements-desktop.txt` in the same environment
used for the rest of the app).
"""
import socket
import subprocess
import sys
import threading
import time

import webview

from app import PORT, _find_reference, app, bootstrap
from config import REFERENCES_DIR

HOST = "127.0.0.1"


class Api:
    """Exposed to the page as window.pywebview.api -- the carousel's "Reveal
    in Finder" button calls window.pywebview.api.reveal(reference_id).

    The one method on this bridge takes an id and resolves the path itself;
    it never accepts a path from the page. app.py's API deliberately never
    exposes a reference's filepath (see CLAUDE.md) -- a bridge that trusted a
    path handed up from JS would reopen exactly that hole, just one process
    over, and would let the page reveal (or, with a different verb later,
    touch) any file readable by this process, not just archive references.
    """

    def reveal(self, reference_id):
        ref = _find_reference(reference_id) if reference_id else None
        if not ref:
            return {"ok": False, "error": "unknown reference"}
        path = REFERENCES_DIR / ref["filepath"]
        if not path.exists():
            return {"ok": False, "error": "file missing"}
        subprocess.run(["open", "-R", str(path)], check=False)
        return {"ok": True}


def _port_is_listening():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.25)
        return sock.connect_ex((HOST, PORT)) == 0


def _port_is_free():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.25)
        return sock.connect_ex((HOST, PORT)) != 0


def _run_flask():
    # use_reloader is off by default when app.run() is called this way, but
    # spelled out because the reloader forks -- under a thread that would
    # spawn a second process and a second window.
    app.run(host=HOST, port=PORT, debug=False, use_reloader=False)


def main():
    if not _port_is_free():
        print(
            f"Port {PORT} is already in use -- refusing to open a window onto "
            f"whatever else is listening there. Stop it first, or stop any "
            f"other instance of this app, then retry."
        )
        sys.exit(1)

    bootstrap()

    server_thread = threading.Thread(target=_run_flask, daemon=True)
    server_thread.start()

    # Poll until Flask actually accepts connections so the webview never
    # loads a dead page and shows a connection-refused screen.
    deadline = time.time() + 10
    while not _port_is_listening():
        if time.time() > deadline:
            print(f"Flask never came up on {HOST}:{PORT} -- aborting.")
            sys.exit(1)
        time.sleep(0.05)

    # webview.start() blocks and must run on the main thread on macOS
    # (Cocoa requires the UI to live there) -- so it goes last, not in a
    # thread of its own.
    webview.create_window("Fashion Reference Library", f"http://{HOST}:{PORT}", js_api=Api())
    webview.start()


if __name__ == "__main__":
    main()
