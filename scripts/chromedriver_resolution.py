"""Resolve a ChromeDriver that exactly matches the browser under test."""
from __future__ import annotations

import os
import re
from pathlib import Path


VERSION_PATTERN = re.compile(r"\b(\d+\.\d+\.\d+\.\d+)\b")


def parse_browser_version(output: str) -> str:
    """Extract the exact four-part version emitted by a Chromium binary."""
    match = VERSION_PATTERN.search(str(output or ""))
    if not match:
        raise RuntimeError("browser_version_unparseable")
    return match.group(1)


def resolve_chromedriver(
    browser_version: str,
    root: Path,
    env: dict[str, str] | None = None,
) -> Path:
    """Resolve an executable driver by explicit override or exact version path."""
    values = os.environ if env is None else env
    explicit = str(values.get("PHANTOM_RELAY_CHROMEDRIVER") or "").strip()
    candidate = Path(explicit).expanduser() if explicit else (
        Path(root) / ".tools" / f"chromedriver-{browser_version}" / "chromedriver"
    )
    candidate = candidate.resolve()
    if not candidate.is_file() or not os.access(candidate, os.X_OK):
        if explicit:
            raise RuntimeError("configured_chromedriver_missing")
        raise RuntimeError(f"matching_chromedriver_missing:{browser_version}")
    return candidate
