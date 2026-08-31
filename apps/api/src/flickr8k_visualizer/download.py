from __future__ import annotations

import hashlib
import logging
import os
from pathlib import Path
from urllib.request import Request, urlopen

LOGGER = logging.getLogger(__name__)

DOWNLOAD_TIMEOUT_SECONDS = 60
USER_AGENT = "flickr8k-visualizer/0.1"
CHUNK_SIZE = 4 * 1024 * 1024


def verify_file(path: Path, expected_size: int, expected_hash: str) -> None:
    if not path.is_file():
        raise ValueError(f"Expected file does not exist: {path}")
    if path.stat().st_size != expected_size:
        raise ValueError(
            f"Unexpected size for {path.name}: {path.stat().st_size}; "
            f"expected {expected_size}"
        )

    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(CHUNK_SIZE):
            digest.update(chunk)
    if digest.hexdigest() != expected_hash:
        raise ValueError(f"Checksum verification failed for {path.name}")


def download_verified_file(
    url: str, destination: Path, *, expected_size: int, expected_hash: str
) -> Path:
    """Download to destination unless a verified copy already exists there."""
    if destination.is_file():
        try:
            verify_file(destination, expected_size, expected_hash)
            LOGGER.info("Using verified download %s", destination.name)
            return destination
        except ValueError:
            destination.unlink()

    destination.parent.mkdir(parents=True, exist_ok=True)
    partial_path = destination.with_suffix(f"{destination.suffix}.partial")
    partial_path.unlink(missing_ok=True)
    LOGGER.info("Downloading %s (%.1f MB)", destination.name, expected_size / 1e6)
    request = Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with (
            urlopen(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response,
            partial_path.open("wb") as output,
        ):
            while chunk := response.read(CHUNK_SIZE):
                output.write(chunk)
        verify_file(partial_path, expected_size, expected_hash)
        os.replace(partial_path, destination)
    except Exception:
        partial_path.unlink(missing_ok=True)
        raise
    return destination
