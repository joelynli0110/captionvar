"""Repair the text encoding of a trace written by an older run_match.py on Windows.

    python agents/reencode_trace.py public/traces/foundry-demo.json

Older versions wrote the trace in the Windows default code page (GBK on a
Chinese-locale system, cp1252 on a Western one) instead of UTF-8. This script
handles three cases and is safe to run more than once:

  1. raw code-page bytes        -> decoded with this machine's code page
  2. UTF-8 that was converted   -> the wrong cp1252 step is undone
     from GBK as if it were      ("Northbridge FC¡¯s" -> "Northbridge FC’s")
     cp1252 (previous version
     of this script)
  3. correct UTF-8              -> left unchanged
"""
import json
import locale
import re
import sys
from pathlib import Path

# Garbled sequences produced by reading GBK bytes as cp1252: lead bytes 0xA1-0xA9.
MOJIBAKE = re.compile("[¡-©][ -ÿ]")
CJK = re.compile("[　-鿿]")


def undo_cp1252_misread(text: str) -> str | None:
    """If text is GBK bytes misread as cp1252, return the repaired text, else None."""
    if not MOJIBAKE.search(text):
        return None
    try:
        fixed = text.encode("cp1252").decode("gbk")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return None
    # The trace contains no Chinese text, so a repair that produces any is wrong.
    if CJK.search(fixed) or MOJIBAKE.search(fixed):
        return None
    return fixed


def repair(raw: bytes) -> tuple[str | None, str]:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        candidates = [locale.getpreferredencoding(False), "gbk", "cp1252"]
        for enc in dict.fromkeys(c.lower() for c in candidates):
            try:
                text = raw.decode(enc)
                json.loads(text)
                return text, f"decoded from {enc}"
            except (UnicodeDecodeError, LookupError, ValueError):
                continue
        raise SystemExit("could not decode the file with UTF-8, the local code page, GBK or cp1252")
    fixed = undo_cp1252_misread(text)
    if fixed is not None:
        return fixed, "repaired text that had been converted from GBK as if it were cp1252"
    return None, "already correct UTF-8, unchanged"


def main(paths: list[str]) -> None:
    for name in paths or ["public/traces/foundry-demo.json"]:
        path = Path(name)
        text, what = repair(path.read_bytes())
        if text is not None:
            json.loads(text)  # never write something that is not valid JSON
            path.write_text(text, encoding="utf-8")
        print(f"{path}: {what}")


if __name__ == "__main__":
    main(sys.argv[1:])
