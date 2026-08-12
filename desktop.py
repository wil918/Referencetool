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
import sys
import threading
import time

import webview

from app import PORT, app, bootstrap

HOST = "127.0.0.1"


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
    webview.create_window("Fashion Reference Library", f"http://{HOST}:{PORT}")
    webview.start()


if __name__ == "__main__":
    main()
