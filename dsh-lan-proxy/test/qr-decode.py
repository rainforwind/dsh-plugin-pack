#!/usr/bin/env python3
"""Decode this plugin's rendered QR PNGs with an independent decoder.

The Node test suite (test/client.mjs) checks the QR matrix structurally: sizes,
finder and timing patterns, alignment patterns, version blocks, and the PNG
container. None of that proves a camera or decoder can *read* the result, so
this script closes the loop by handing the rendered images to a third-party
decoder and comparing what comes back with the URL that went in.

It is optional and not part of `node test/client.mjs`, because it needs
packages the plugin does not depend on. Set it up once with:

    python3 -m venv /tmp/qrcheck
    /tmp/qrcheck/bin/pip install pillow opencv-python-headless
    /tmp/qrcheck/bin/python test/qr-decode.py

Exits non-zero if any URL fails to survive the round trip.
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent.parent

# A spread of realistic URLs: loopback-free LAN addresses, Tailscale CGNAT,
# IPv6, and lengths that land on several QR versions.
URLS = [
    "http://100.64.0.1:3081/?token=deadbeef",
    "http://100.64.0.1:3081/?token=0123456789abcdef0123456789abcdef",
    "http://192.168.1.20:3081/?token=Zx9",
    "http://10.0.0.1:3081/?token=a",
    "http://172.16.31.7:3081/?token=" + "a" * 120,
    "http://[fd7a:115c:a1e0::1]:3081/?token=tailscale",
]


def render(urls, out_dir):
    """Render each URL through the plugin's own client module."""
    script = f"""
import {{ readFile, writeFile }} from "node:fs/promises";
let descriptor;
globalThis.window = {{ __ModuleLoader__: {{ load: (d) => {{ descriptor = d; }} }} }};
const fakeReact = {{ createElement: () => ({{}}), useState: () => {{}}, useSyncExternalStore: () => {{}}, useEffect: () => {{}} }};
await import({json.dumps(str(PLUGIN_DIR / "client" / "client.js"))});
const api = descriptor.factory((id) => {{ if (id === "react") return fakeReact; throw new Error(id); }}).__test;
const urls = {json.dumps(urls)};
const out = {{}};
for (const url of urls) {{
  const dataUrl = api.qrDataUrl(url);
  out[url] = dataUrl === null ? null : dataUrl.slice("data:image/png;base64,".length);
}}
await writeFile({json.dumps(str(out_dir / "qr.json"))}, JSON.stringify(out));
console.log("rendered", urls.length);
"""
    result = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True)
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        raise SystemExit("rendering failed")
    return json.loads((out_dir / "qr.json").read_text())


def main():
    try:
        import base64

        import cv2
        import numpy as np
    except ImportError as error:
        print(f"missing dependency: {error}", file=sys.stderr)
        print("see the setup notes at the top of this file", file=sys.stderr)
        return 2

    detector = cv2.QRCodeDetector()
    failures = []
    with tempfile.TemporaryDirectory() as tmp:
        rendered = render(URLS, Path(tmp))
        for url, payload in rendered.items():
            if payload is None:
                failures.append((url, "no PNG produced"))
                continue
            image_path = Path(tmp) / "code.png"
            image_path.write_bytes(base64.b64decode(payload))
            image = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE)
            if image is None:
                failures.append((url, "decoder could not open the PNG"))
                continue
            decoded, points, _ = detector.detectAndDecode(image)
            status = "ok  " if decoded == url else "FAIL"
            print(f"{status} {len(payload) * 3 // 4:>7} bytes  {url}")
            if decoded != url:
                failures.append((url, f"decoded {decoded!r}"))

    print()
    if failures:
        for url, reason in failures:
            print(f"FAILED {url}: {reason}", file=sys.stderr)
        return 1
    print(f"all {len(URLS)} URLs round-tripped through an independent decoder")
    return 0


if __name__ == "__main__":
    sys.exit(main())
