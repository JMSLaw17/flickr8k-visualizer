from __future__ import annotations

import sqlite3
from collections import Counter, defaultdict
from contextlib import closing
from pathlib import Path
from typing import Any

from .caption_text import caption_has_term, caption_matches_query, caption_token_count
from .models import SampleFilters

# Caption length in whitespace-separated tokens. The same expression drives the
# overview histogram and the gallery word-count filter, so both always agree.
CAPTION_TOKEN_COUNT_SQL = "caption_token_count(captions.text)"

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
    connection.create_function(
        "caption_has_term", 2, caption_has_term, deterministic=True
    )
    connection.create_function(
        "caption_token_count", 1, caption_token_count, deterministic=True
    )
    connection.create_function(
        "caption_matches_query", 2, caption_matches_query, deterministic=True
    )
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


def _filter_clauses(filters: SampleFilters) -> tuple[str, list[object]]:
    clauses: list[str] = []
    parameters: list[object] = []

    if filters.split is not None:
        clauses.append("split = ?")
        parameters.append(filters.split)

    if filters.term is not None:
        clauses.append(
            "EXISTS (SELECT 1 FROM captions WHERE captions.sample_id = samples.id"
            " AND caption_has_term(captions.text, ?))"
        )
        parameters.append(filters.term)

    if filters.q is not None:
        clauses.append(
            "EXISTS (SELECT 1 FROM captions WHERE captions.sample_id = samples.id"
            " AND caption_matches_query(captions.text, ?))"
        )
        parameters.append(filters.q)

    word_bounds = [
        (f"{CAPTION_TOKEN_COUNT_SQL} >= ?", filters.min_words),
        (f"{CAPTION_TOKEN_COUNT_SQL} < ?", filters.max_words),
    ]
    word_conditions = [(sql, bound) for sql, bound in word_bounds if bound is not None]
    if word_conditions:
        conditions = " AND ".join(sql for sql, _ in word_conditions)
        clauses.append(
            "EXISTS (SELECT 1 FROM captions WHERE captions.sample_id = samples.id"
            f" AND {conditions})"
        )
        parameters.extend(bound for _, bound in word_conditions)

    for column, low, high in (
        ("width", filters.min_width, filters.max_width),
        ("height", filters.min_height, filters.max_height),
        ("CAST(width AS REAL) / height", filters.min_ratio, filters.max_ratio),
    ):
        if low is not None:
            clauses.append(f"{column} >= ?")
            parameters.append(low)
        if high is not None:
            clauses.append(f"{column} < ?")
            parameters.append(high)

    where_clause = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    return where_clause, parameters


def list_samples(
    database_path: Path,
    *,
    limit: int,
    offset: int,
    filters: SampleFilters,
) -> tuple[int, list[dict[str, Any]]]:
    _require_database(database_path)
    where_clause, parameters = _filter_clauses(filters)

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
            records = [dict(row) for row in rows]
            matched_captions: defaultdict[str, list[str]] = defaultdict(list)
            if filters.q is not None:
                matched_captions = _load_captions(
                    connection,
                    [record["id"] for record in records],
                    query=filters.q,
                )
    except sqlite3.Error as error:
        raise DatabaseUnavailableError("Dataset database is not ready") from error

    for record in records:
        record["matched_captions"] = matched_captions[record["id"]]
    return total, records


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


def get_overview_source(database_path: Path) -> dict[str, Any]:
    """Raw per-value counts and duplicate members behind the overview endpoint."""
    _require_database(database_path)
    try:
        with closing(connect_database(database_path)) as connection:
            split_counts = _value_counts(
                connection, "SELECT split, COUNT(*) FROM samples GROUP BY split"
            )
            width_counts = _value_counts(
                connection, "SELECT width, COUNT(*) FROM samples GROUP BY width"
            )
            height_counts = _value_counts(
                connection, "SELECT height, COUNT(*) FROM samples GROUP BY height"
            )
            ratio_counts = _value_counts(
                connection,
                """
                SELECT CAST(width AS REAL) / height AS ratio, COUNT(*)
                FROM samples GROUP BY ratio
                """,
            )
            caption_token_counts = _value_counts(
                connection,
                f"""
                SELECT {CAPTION_TOKEN_COUNT_SQL} AS tokens, COUNT(*)
                FROM captions GROUP BY tokens
                """,
            )
            captions = [
                row[0] for row in connection.execute("SELECT text FROM captions")
            ]
            duplicate_members = [
                dict(row)
                for row in connection.execute(
                    """
                    SELECT samples.content_sha256, samples.id, samples.source_id,
                           samples.split, samples.thumbnail_path
                    FROM duplicate_groups
                    JOIN samples USING (content_sha256)
                    ORDER BY samples.content_sha256, samples.id
                    """
                )
            ]
    except sqlite3.Error as error:
        raise DatabaseUnavailableError("Dataset database is not ready") from error

    return {
        "split_counts": split_counts,
        "width_counts": width_counts,
        "height_counts": height_counts,
        "ratio_counts": ratio_counts,
        "caption_token_counts": caption_token_counts,
        "captions": captions,
        "duplicate_members": duplicate_members,
    }


def _value_counts(connection: sqlite3.Connection, query: str) -> Counter[Any]:
    return Counter({row[0]: row[1] for row in connection.execute(query)})


def _load_captions(
    connection: sqlite3.Connection,
    sample_ids: list[str],
    *,
    query: str | None = None,
) -> defaultdict[str, list[str]]:
    captions: defaultdict[str, list[str]] = defaultdict(list)
    if not sample_ids:
        return captions

    placeholders = ", ".join("?" for _ in sample_ids)
    query_clause = ""
    parameters: list[object] = [*sample_ids]
    if query is not None:
        query_clause = " AND caption_matches_query(text, ?)"
        parameters.append(query)

    rows = connection.execute(
        f"""
        SELECT sample_id, text
        FROM captions
        WHERE sample_id IN ({placeholders})
          {query_clause}
        ORDER BY sample_id, position
        """,
        parameters,
    ).fetchall()
    for row in rows:
        captions[row["sample_id"]].append(row["text"])
    return captions


def _require_database(database_path: Path) -> None:
    if not database_path.is_file():
        raise DatabaseUnavailableError("Dataset database is not ready")
