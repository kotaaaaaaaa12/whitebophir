"""Run Beatbump and its private companion in one Cloudflare Container."""
import os
import secrets
import signal
import subprocess
import sys
import time
import threading
import urllib.request


def main():
    env = os.environ.copy()
    key = env.get("SERVER_SECRET_KEY") or secrets.token_hex(8)
    if len(key) != 16 or not key.isascii() or not key.isalnum():
        raise ValueError("SERVER_SECRET_KEY must contain exactly 16 ASCII letters or digits")
    env["SERVER_SECRET_KEY"] = key
    env["COMPANION_SECRET_KEY"] = key
    env.setdefault("MEDIA_PROXY_KEY", key)
    children = []
    stopping = False

    def start(command):
        child = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        children.append(child)

        def relay_logs():
            for line in child.stdout:
                # Upstream prints its configuration at startup; keep internal keys private.
                sys.stdout.write(line.replace(key, "[redacted]"))
                sys.stdout.flush()

        threading.Thread(target=relay_logs, daemon=True).start()
        return child

    def shutdown(*_):
        nonlocal stopping
        stopping = True
        for child in children:
            if child.poll() is None:
                child.terminate()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        print("Starting private Invidious companion", flush=True)
        companion = start(["/app/invidious_companion"])
        ready = False
        for _ in range(120):
            if stopping:
                return 0
            if companion.poll() is not None:
                raise RuntimeError("Companion exited during startup")
            try:
                with urllib.request.urlopen("http://127.0.0.1:8282/healthz", timeout=1) as response:
                    ready = response.status == 200
            except OSError:
                pass
            if ready:
                break
            time.sleep(0.5)
        if not ready:
            raise RuntimeError("Companion did not become ready")
        if stopping:
            return 0
        print("Starting Beatbump web server on port 8080", flush=True)
        start(["/app/beat-server"])
        while not stopping and all(child.poll() is None for child in children):
            time.sleep(0.5)
        if stopping:
            return 0
        print("A service stopped; shutting down this container", flush=True)
        return 1
    finally:
        shutdown()
        deadline = time.monotonic() + 10
        for child in children:
            try:
                child.wait(timeout=max(0.1, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


if __name__ == "__main__":
    sys.exit(main())
