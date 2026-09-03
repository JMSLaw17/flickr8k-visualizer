from __future__ import annotations

import sqlite3
from collections import Counter, defaultdict
from collections.abc import Iterator
from contextlib import closing, contextmanager
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


@contextmanager
def open_database(database_path: Path) -> Iterator[sqlite3.Connection]:
    """Open the prepared database for reading.

    A missing file or any SQLite failure surfaces as DatabaseUnavailableError,
    which the API reports as "not prepared".
    """
    if not database_path.is_file():
        raise DatabaseUnavailableError("Dataset database is not ready")
    try:
        with closing(connect_database(database_path)) as connection:
            yield connection
    except sqlite3.Error as error:
        raise DatabaseUnavailableError("Dataset database is not ready") from error


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


# A caption predicate is SQL over one `captions` row plus its parameters.
CaptionPredicate = tuple[str, list[object]]


def _text_caption_predicates(filters: SampleFilters) -> list[CaptionPredicate]:
    """The exact-term and phrase conditions, one per active filter."""
    predicates: list[CaptionPredicate] = []
    if filters.term is not None:
        predicates.append(("caption_has_term(captions.text, ?)", [filters.term]))
    if filters.q is not None:
        predicates.append(("caption_matches_query(captions.text, ?)", [filters.q]))
    return predicates


def _length_caption_predicate(filters: SampleFilters) -> list[CaptionPredicate]:
    """The caption-length condition, when either bound is set."""
    bounds = [
        (f"{CAPTION_TOKEN_COUNT_SQL} >= ?", filters.min_words),
        (f"{CAPTION_TOKEN_COUNT_SQL} < ?", filters.max_words),
    ]
    active = [(sql, bound) for sql, bound in bounds if bound is not None]
    if not active:
        return []
    return [(" AND ".join(sql for sql, _ in active), [bound for _, bound in active])]


def _caption_predicates(filters: SampleFilters) -> list[CaptionPredicate]:
    """Every caption-level condition; a sample matches when each holds for
    at least one of its captions, not necessarily the same one."""
    return [*_text_caption_predicates(filters), *_length_caption_predicate(filters)]


def _matched_caption_predicates(filters: SampleFilters) -> list[CaptionPredicate]:
    """Conditions a caption may satisfy (any of them) to be shown as a match.

    Text filters decide what is shown, since they are what highlighting can
    point at; the length filter only when it is the sole caption filter.
    """
    return _text_caption_predicates(filters) or _length_caption_predicate(filters)


def _any_of(predicates: list[CaptionPredicate]) -> CaptionPredicate:
    """OR the predicates into one condition; `0` when there are none."""
    if not predicates:
        return ("0", [])
    return (
        " OR ".join(f"({condition})" for condition, _ in predicates),
        [value for _, values in predicates for value in values],
    )


def filter_clauses(filters: SampleFilters) -> tuple[list[str], list[object]]:
    clauses: list[str] = []
    parameters: list[object] = []

    if filters.split is not None:
        clauses.append("split = ?")
        parameters.append(filters.split)

    for condition, values in _caption_predicates(filters):
        clauses.append(
            "EXISTS (SELECT 1 FROM captions WHERE captions.sample_id = samples.id"
            f" AND {condition})"
        )
        parameters.extend(values)

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
       ) AS caption,
       EXISTS (
           SELECT 1
           FROM duplicate_groups
           WHERE duplicate_groups.content_sha256 = samples.content_sha256
       ) AS duplicate
FROM samples
"""


def load_summary_records(
    connection: sqlite3.Connection,
    sample_ids: list[str],
    *,
    filters: SampleFilters,
) -> list[dict[str, Any]]:
    """Summary records for the given IDs, returned in the given order.

    matched_captions is populated only while a caption-level filter is
    active, matching list_samples.
    """
    if not sample_ids:
        return []

    placeholders = ", ".join("?" for _ in sample_ids)
    rows = connection.execute(
        f"{SAMPLE_SUMMARY_SELECT} WHERE id IN ({placeholders})", sample_ids
    ).fetchall()
    records_by_id = {row["id"]: dict(row) for row in rows}
    matched_captions = _load_matched_captions(connection, sample_ids, filters)
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
    clauses, parameters = filter_clauses(filters)
    where_clause = compose_where_clause(clauses)

    with open_database(database_path) as connection:
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
        matched_captions = _load_matched_captions(
            connection, [record["id"] for record in records], filters
        )

    for record in records:
        record["matched_captions"] = matched_captions[record["id"]]
    return total, records


def get_sample(
    database_path: Path,
    sample_id: str,
    *,
    filters: SampleFilters,
) -> dict[str, Any] | None:
    with open_database(database_path) as connection:
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

        # A sample outside the filters gets no scope-relative information:
        # neither neighbors nor matched captions.
        clauses, parameters = filter_clauses(filters)
        in_scope = _sample_in_scope(connection, sample_id, clauses, parameters)
        matched, matched_parameters = _any_of(
            _matched_caption_predicates(filters) if in_scope else []
        )
        caption_rows = connection.execute(
            f"""
            SELECT text, ({matched}) AS matched
            FROM captions
            WHERE sample_id = ?
            ORDER BY position
            """,
            (*matched_parameters, sample_id),
        ).fetchall()
        previous_id, next_id = (
            _sample_neighbors(connection, sample_id, clauses, parameters)
            if in_scope
            else (None, None)
        )

    return {
        **dict(row),
        "captions": [caption["text"] for caption in caption_rows],
        "matched_positions": [
            position
            for position, caption in enumerate(caption_rows)
            if caption["matched"]
        ],
        "previous_id": previous_id,
        "next_id": next_id,
    }


def _sample_in_scope(
    connection: sqlite3.Connection,
    sample_id: str,
    clauses: list[str],
    parameters: list[object],
) -> bool:
    row = connection.execute(
        f"SELECT 1 FROM samples{compose_where_clause(clauses, 'id = ?')}",
        (*parameters, sample_id),
    ).fetchone()
    return row is not None


def _sample_neighbors(
    connection: sqlite3.Connection,
    sample_id: str,
    clauses: list[str],
    parameters: list[object],
) -> tuple[str | None, str | None]:
    """Stable-ID neighbors within the filter clauses; the sample must be in scope."""

    def neighbor(comparison: str, order: str) -> str | None:
        row = connection.execute(
            f"""
            SELECT id
            FROM samples
            {compose_where_clause(clauses, f"id {comparison} ?")}
            ORDER BY id {order}
            LIMIT 1
            """,
            (*parameters, sample_id),
        ).fetchone()
        return row["id"] if row is not None else None

    return neighbor("<", "DESC"), neighbor(">", "ASC")


def get_overview_source(
    database_path: Path, *, filters: SampleFilters
) -> dict[str, Any]:
    """Raw per-value counts and duplicate members behind the overview endpoint.

    The gallery filters scope every count; duplicate members are always
    dataset-wide.
    """
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
    with open_database(database_path) as connection:
        connection.execute(
            f"CREATE TEMP TABLE scope AS SELECT id, split FROM samples{where_clause}",
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


def _load_matched_captions(
    connection: sqlite3.Connection,
    sample_ids: list[str],
    filters: SampleFilters,
) -> defaultdict[str, list[str]]:
    """Captions to show as matches per sample; empty without a caption filter."""
    captions: defaultdict[str, list[str]] = defaultdict(list)
    predicates = _matched_caption_predicates(filters)
    if not predicates or not sample_ids:
        return captions

    placeholders = ", ".join("?" for _ in sample_ids)
    matched, matched_parameters = _any_of(predicates)
    rows = connection.execute(
        f"""
        SELECT sample_id, text
        FROM captions
        WHERE sample_id IN ({placeholders}) AND ({matched})
        ORDER BY sample_id, position
        """,
        [*sample_ids, *matched_parameters],
    ).fetchall()
    for row in rows:
        captions[row["sample_id"]].append(row["text"])
    return captions
