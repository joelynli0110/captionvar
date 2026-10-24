"""Re-encode a trace written by an older run_match.py on Windows (cp1252) as UTF-8.

    python agents/reencode_trace.py public/traces/foundry-demo.json

Does nothing if the file is already valid UTF-8, so it is safe to run twice.
"""
import sys
from pathlib import Path

for name in sys.argv[1:] or ["public/traces/foundry-demo.json"]:
    path = Path(name)
    raw = path.read_bytes()
    try:
        raw.decode("utf-8")
        print(f"{path}: already UTF-8, unchanged")
    except UnicodeDecodeError:
        path.write_text(raw.decode("cp1252"), encoding="utf-8")
        print(f"{path}: converted from cp1252 to UTF-8")
