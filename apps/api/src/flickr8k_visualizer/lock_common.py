"""Reading and field validation shared by the dataset and model lock loaders."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from importlib.resources import files
from pathlib import Path

REPO_ID_PATTERN = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
REVISION_PATTERN = re.compile(r"[0-9a-f]{40}")
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")


def read_lock_object(
    path: Path | None, *, filename: str, schema_version: int, kind: str
) -> tuple[Mapping[str, object], object]:
    """Load the packaged lock file, or the given path, and check its schema.

    Returns the parsed object and the source it came from, for error messages.
    """
    source = path or files("flickr8k_visualizer").joinpath(filename)
    try:
        value = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Could not read {kind} lock file: {source}") from error

    if not isinstance(value, Mapping):
        raise RuntimeError(
            f"{kind.capitalize()} lock must contain a JSON object: {source}"
        )
    if value.get("schema_version") != schema_version:
        raise RuntimeError(
            f"Unsupported {kind} lock schema in {source}; expected {schema_version}"
        )
    return value, source


def require_repo_id(value: Mapping[str, object], source: object, kind: str) -> str:
    repo_id = value.get("repo_id")
    if not isinstance(repo_id, str) or not REPO_ID_PATTERN.fullmatch(repo_id):
        raise RuntimeError(f"Invalid {kind} repository ID in {source}")
    return repo_id


def require_revision(value: Mapping[str, object], source: object, kind: str) -> str:
    revision = value.get("revision")
    if not isinstance(revision, str) or not REVISION_PATTERN.fullmatch(revision):
        raise RuntimeError(
            f"{kind.capitalize()} revision in {source} must be a full 40-character"
            " commit SHA"
        )
    return revision


def require_entries(
    value: Mapping[str, object], key: str, source: object, kind: str, noun: str
) -> list[object]:
    entries = value.get(key)
    if not isinstance(entries, list) or not entries:
        raise RuntimeError(
            f"{kind.capitalize()} lock must contain at least one {noun}: {source}"
        )
    return entries


def is_sha256(value: object) -> bool:
    return isinstance(value, str) and SHA256_PATTERN.fullmatch(value) is not None


def is_positive_integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0
