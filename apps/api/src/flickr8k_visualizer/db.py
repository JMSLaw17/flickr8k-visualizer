from __future__ import annotations

import sqlite3
from collections import defaultdict
from contextlib import closing
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS samples (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    split TEXT NOT NULL CHECK (split IN ('train', 'validation', 'test')),
    content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
    width INTEGER NOT NULL CHECK (width > 0),
    height INTEGER NOT NULL CHECK (height > 0),
    mime_type TEXT NOT NULL,
    file_size_bytes INTEGER NOT NULL CHECK (file_size_bytes > 0),
    original_path TEXT NOT NULL,
    thumbnail_path TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS samples_split_idx ON samples (split);
CREATE INDEX IF NOT EXISTS samples_content_sha256_idx ON samples (content_sha256);

CREATE TABLE IF NOT EXISTS duplicate_groups (
    content_sha256 TEXT PRIMARY KEY CHECK (length(content_sha256) = 64),
    sample_count INTEGER NOT NULL CHECK (sample_count > 1)
);

CREATE TABLE IF NOT EXISTS captions (
    sample_id TEXT NOT NULL REFERENCES samples (id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    text TEXT NOT NULL,
    PRIMARY KEY (sample_id, position)
);
"""


class DatabaseUnavailableError(RuntimeError):
    pass


def connect_database(database_path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def initialize_database(database_path: Path) -> None:
    database_path.parent.mkdir(parents=True, exist_ok=True)
    with closing(connect_database(database_path)) as connection:
        connection.executescript(SCHEMA)
        connection.commit()


def materialize_duplicate_groups(connection: sqlite3.Connection) -> int:
    connection.execute("DELETE FROM duplicate_groups")
    connection.execute(
        """
        INSERT INTO duplicate_groups (content_sha256, sample_count)
        SELECT content_sha256, COUNT(*)
        FROM samples
        GROUP BY content_sha256
        HAVING COUNT(*) > 1
        ORDER BY content_sha256
        """
    )
    return connection.execute("SELECT COUNT(*) FROM duplicate_groups").fetchone()[0]


def list_samples(
    database_path: Path,
    *,
    limit: int,
    offset: int,
    split: str | None,
) -> tuple[int, list[dict[str, Any]]]:
    _require_database(database_path)
    where_clause = " WHERE split = ?" if split is not None else ""
    parameters: tuple[object, ...] = (split,) if split is not None else ()

    try:
        with closing(connect_database(database_path)) as connection:
            total = connection.execute(
                f"SELECT COUNT(*) FROM samples{where_clause}", parameters
            ).fetchone()[0]
            rows = connection.execute(
                f"""
                SELECT id, source_id, split, width, height, thumbnail_path,
                       (
                           SELECT text
                           FROM captions
                           WHERE sample_id = samples.id
                           ORDER BY position
                           LIMIT 1
                       ) AS caption
                FROM samples
                {where_clause}
                ORDER BY id
                LIMIT ? OFFSET ?
                """,
                (*parameters, limit, offset),
            ).fetchall()
    except sqlite3.Error as error:
        raise DatabaseUnavailableError("Dataset database is not ready") from error

    return total, [dict(row) for row in rows]


def get_sample(database_path: Path, sample_id: str) -> dict[str, Any] | None:
    _require_database(database_path)
    try:
        with closing(connect_database(database_path)) as connection:
            row = connection.execute(
                """
                SELECT id, source_id, split, content_sha256, width, height,
                       mime_type, file_size_bytes, original_path, thumbnail_path
                FROM samples
                WHERE id = ?
                """,
                (sample_id,),
            ).fetchone()
            if row is None:
                return None

            captions = _load_captions(connection, [sample_id])
    except sqlite3.Error as error:
        raise DatabaseUnavailableError("Dataset database is not ready") from error

    return {**dict(row), "captions": captions[sample_id]}


def _load_captions(
    connection: sqlite3.Connection, sample_ids: list[str]
) -> defaultdict[str, list[str]]:
    captions: defaultdict[str, list[str]] = defaultdict(list)
    if not sample_ids:
        return captions

    placeholders = ", ".join("?" for _ in sample_ids)
    rows = connection.execute(
        f"""
        SELECT sample_id, text
        FROM captions
        WHERE sample_id IN ({placeholders})
        ORDER BY sample_id, position
        """,
        sample_ids,
    ).fetchall()
    for row in rows:
        captions[row["sample_id"]].append(row["text"])
    return captions


def _require_database(database_path: Path) -> None:
    if not database_path.is_file():
        raise DatabaseUnavailableError("Dataset database is not ready")
