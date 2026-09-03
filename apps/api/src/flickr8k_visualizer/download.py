from __future__ import annotations

import hashlib
import logging
import os
import time
from http.client import HTTPException
from pathlib import Path
from urllib.request import Request, urlopen

LOGGER = logging.getLogger(__name__)

DOWNLOAD_TIMEOUT_SECONDS = 60
DOWNLOAD_ATTEMPTS = 5
USER_AGENT = "flickr8k-visualizer/0.1"
CHUNK_SIZE = 4 * 1024 * 1024
# Files at least this large log progress at each quarter, with the transfer
# rate, so a slow link is visible rather than looking like a hang.
PROGRESS_MIN_BYTES = 50 * 1024 * 1024


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
    """Download to destination unless a verified copy already exists there.

    An interrupted transfer is resumed with a range request, up to
    DOWNLOAD_ATTEMPTS times, before the whole download is given up.
    """
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
    try:
        for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
            try:
                _fetch(url, partial_path, expected_size)
                break
            except (OSError, HTTPException) as error:
                if attempt == DOWNLOAD_ATTEMPTS:
                    raise
                LOGGER.warning(
                    "  %s: %s; resuming (attempt %d of %d)",
                    destination.name,
                    error,
                    attempt + 1,
                    DOWNLOAD_ATTEMPTS,
                )
        verify_file(partial_path, expected_size, expected_hash)
        os.replace(partial_path, destination)
    except Exception:
        partial_path.unlink(missing_ok=True)
        raise
    return destination


def _fetch(url: str, partial_path: Path, expected_size: int) -> None:
    """Download into partial_path, resuming whatever is already there.

    A body that ends before expected_size means the connection was closed
    early; that is raised as an OSError so the caller can retry.
    """
    offset = partial_path.stat().st_size if partial_path.is_file() else 0
    if offset >= expected_size:
        return

    headers = {"User-Agent": USER_AGENT}
    if offset:
        headers["Range"] = f"bytes={offset}-"
    request = Request(url, headers=headers)
    with urlopen(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
        if offset and getattr(response, "status", 206) != 206:
            # The server ignored the range and is sending the whole file.
            offset = 0
        with partial_path.open("ab" if offset else "wb") as output:
            started = time.monotonic()
            received = offset
            step = expected_size // 4
            next_report = 0
            if expected_size >= PROGRESS_MIN_BYTES:
                next_report = step * (received // step + 1)
            while chunk := response.read(CHUNK_SIZE):
                output.write(chunk)
                received += len(chunk)
                if next_report and received >= next_report:
                    elapsed = max(time.monotonic() - started, 1e-6)
                    LOGGER.info(
                        "  %s: %d%% at %.1f MB/s",
                        partial_path.name.removesuffix(".partial"),
                        100 * received // expected_size,
                        (received - offset) / elapsed / 1e6,
                    )
                    next_report += step

    if received < expected_size:
        raise OSError(f"connection closed after {received} of {expected_size} bytes")
