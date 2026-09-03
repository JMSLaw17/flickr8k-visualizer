"""Filesystem helpers."""

from __future__ import annotations

import os
from pathlib import Path


def write_atomic(path: Path, data: str | bytes) -> None:
    """Write through a temporary sibling and rename, so readers never see a
    partial file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    if isinstance(data, bytes):
        temporary_path.write_bytes(data)
    else:
        temporary_path.write_text(data, encoding="utf-8")
    os.replace(temporary_path, path)
