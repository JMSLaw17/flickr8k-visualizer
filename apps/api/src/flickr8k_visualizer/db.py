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


def filter_clauses(filters: SampleFilters) -> tuple[list[str], list[object]]:
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

    return clauses, parameters


def compose_where_clause(clauses: list[str], *additional: str) -> str:
    all_clauses = (*clauses, *additional)
    if not all_clauses:
        return ""
    return " WHERE " + " AND ".join(f"({clause})" for clause in all_clauses)


# The one projection behind every gallery card, whichever endpoint serves it.
SAMPLE_SUMMARY_SELECT = """
SELECT id, source_id, split, width, height, thumbnail_path,
       (
           SELECT text
           FROM captions
           WHERE sample_id = samples.id
           ORDER BY position
           LIMIT 1
       ) AS caption
FROM samples
"""


def load_summary_records(
    connection: sqlite3.Connection,
    sample_ids: list[str],
    *,
    query: str | None = None,
) -> list[dict[str, Any]]:
    """Summary records for the given IDs, returned in the given order.

    matched_captions is populated only when a caption query is given,
    matching list_samples.
    """
    if not sample_ids:
        return []

    placeholders = ", ".join("?" for _ in sample_ids)
    rows = connection.execute(
        f"{SAMPLE_SUMMARY_SELECT} WHERE id IN ({placeholders})", sample_ids
    ).fetchall()
    records_by_id = {row["id"]: dict(row) for row in rows}
    matched_captions: defaultdict[str, list[str]] = (
        _load_captions(connection, sample_ids, query=query)
        if query is not None
        else defaultdict(list)
    )
    return [
        {**records_by_id[sample_id], "matched_captions": matched_captions[sample_id]}
        for sample_id in sample_ids
    ]


def list_samples(
    database_path: Path,
    *,
    limit: int,
    offset: int,
    filters: SampleFilters,
) -> tuple[int, list[dict[str, Any]]]:
    _require_database(database_path)
    clauses, parameters = filter_clauses(filters)
    where_clause = compose_where_clause(clauses)

    try:
        with closing(connect_database(database_path)) as connection:
            total = connection.execute(
                f"SELECT COUNT(*) FROM samples{where_clause}", parameters
            ).fetchone()[0]
            rows = connection.execute(
                f"""
                {SAMPLE_SUMMARY_SELECT}
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


def get_sample(
    database_path: Path,
    sample_id: str,
    *,
    filters: SampleFilters,
) -> dict[str, Any] | None:
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
            previous_id, next_id = _sample_neighbors(connection, sample_id, filters)
    except sqlite3.Error as error:
        raise DatabaseUnavailableError("Dataset database is not ready") from error

    return {
        **dict(row),
        "captions": captions[sample_id],
        "previous_id": previous_id,
        "next_id": next_id,
    }


def _sample_neighbors(
    connection: sqlite3.Connection,
    sample_id: str,
    filters: SampleFilters,
) -> tuple[str | None, str | None]:
    clauses, parameters = filter_clauses(filters)
    matching_sample = connection.execute(
        f"SELECT 1 FROM samples{compose_where_clause(clauses, 'id = ?')}",
        (*parameters, sample_id),
    ).fetchone()
    if matching_sample is None:
        return None, None

    previous = connection.execute(
        f"""
        SELECT id
        FROM samples
        {compose_where_clause(clauses, "id < ?")}
        ORDER BY id DESC
        LIMIT 1
        """,
        (*parameters, sample_id),
    ).fetchone()
    next_sample = connection.execute(
        f"""
        SELECT id
        FROM samples
        {compose_where_clause(clauses, "id > ?")}
        ORDER BY id
        LIMIT 1
        """,
        (*parameters, sample_id),
    ).fetchone()
    return (
        previous["id"] if previous is not None else None,
        next_sample["id"] if next_sample is not None else None,
    )


def get_overview_source(
    database_path: Path, *, filters: SampleFilters
) -> dict[str, Any]:
    """Raw per-value counts and duplicate members behind the overview endpoint.

    The gallery filters scope every count; duplicate members are always
    dataset-wide.
    """
    _require_database(database_path)
    # The caption predicates call Python functions per row, so they are
    # evaluated once into a temporary scope table that every count joins,
    # instead of once per aggregate query. The split is left out of that
    # table so the split chart can compare the other filters across splits;
    # every other count applies it on top.
    clauses, parameters = filter_clauses(filters.model_copy(update={"split": None}))
    where_clause = compose_where_clause(clauses)
    split_clause = " WHERE scope.split = ?" if filters.split is not None else ""
    split_parameters = [filters.split] if filters.split is not None else []
    samples_in_scope = f"FROM samples JOIN scope ON scope.id = samples.id{split_clause}"
    captions_in_scope = (
        f"FROM captions JOIN scope ON scope.id = captions.sample_id{split_clause}"
    )
    try:
        with closing(connect_database(database_path)) as connection:
            connection.execute(
                "CREATE TEMP TABLE scope AS"
                f" SELECT id, split FROM samples{where_clause}",
                parameters,
            )
            split_counts = _value_counts(
                connection, "SELECT split, COUNT(*) FROM scope GROUP BY split", []
            )
            sample_count = connection.execute(
                f"SELECT COUNT(*) FROM scope{split_clause}", split_parameters
            ).fetchone()[0]
            dimension_counts = {
                (row[0], row[1]): row[2]
                for row in connection.execute(
                    f"SELECT width, height, COUNT(*) {samples_in_scope}"
                    " GROUP BY width, height",
                    split_parameters,
                )
            }
            ratio_counts = _value_counts(
                connection,
                f"SELECT CAST(width AS REAL) / height AS ratio, COUNT(*)"
                f" {samples_in_scope} GROUP BY ratio",
                split_parameters,
            )
            caption_token_counts = _value_counts(
                connection,
                f"SELECT {CAPTION_TOKEN_COUNT_SQL} AS tokens, COUNT(*)"
                f" {captions_in_scope} GROUP BY tokens",
                split_parameters,
            )
            captions = [
                row[0]
                for row in connection.execute(
                    f"SELECT captions.text {captions_in_scope}", split_parameters
                )
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
        "sample_count": sample_count,
        "split_counts": split_counts,
        "dimension_counts": dimension_counts,
        "ratio_counts": ratio_counts,
        "caption_token_counts": caption_token_counts,
        "captions": captions,
        "duplicate_members": duplicate_members,
    }


def _value_counts(
    connection: sqlite3.Connection, query: str, parameters: list[object]
) -> Counter[Any]:
    return Counter({row[0]: row[1] for row in connection.execute(query, parameters)})


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
