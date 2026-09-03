from __future__ import annotations

import json
import logging
import os
import sqlite3
from collections.abc import Iterator, Mapping
from contextlib import closing, contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

import numpy as np
from PIL import Image, ImageOps

from .config import Settings
from .dataset_lock import DatasetLock, load_dataset_lock
from .db import (
    DatabaseUnavailableError,
    compose_where_clause,
    connect_database,
    filter_clauses,
    load_summary_records,
    open_database,
)
from .fs import write_atomic
from .model_lock import ClipModelLock, load_model_lock
from .models import SampleFilters

LOGGER = logging.getLogger(__name__)

VISUAL_MANIFEST_SCHEMA_VERSION = 1
# Larger batches amortize per-call overhead; 128 images is about 80 MB of input.
EMBEDDING_BATCH_SIZE = 128
VECTOR_DTYPE = "<f4"  # little-endian float32


class VisualIndexUnavailableError(RuntimeError):
    pass


class ImageEncoder(Protocol):
    def encode_images(self, images: list[Image.Image]) -> np.ndarray: ...


class TextEncoder(Protocol):
    def encode_text(self, text: str) -> np.ndarray: ...


def embeddings_schema(vector_byte_length: int) -> str:
    return f"""
    CREATE TABLE IF NOT EXISTS clip_embeddings (
        sample_id TEXT PRIMARY KEY REFERENCES samples (id) ON DELETE CASCADE,
        vector BLOB NOT NULL CHECK (length(vector) = {vector_byte_length})
    )
    """


def build_visual_index(
    database_path: Path,
    data_dir: Path,
    encoder: ImageEncoder,
    *,
    dimension: int,
    batch_size: int = EMBEDDING_BATCH_SIZE,
) -> int:
    """Build clip_embeddings off-line, then atomically publish the database."""
    if not database_path.is_file():
        raise DatabaseUnavailableError("Dataset database is not ready")

    temporary_database_path = database_path.with_name(
        f".{database_path.name}.visual-search.{os.getpid()}"
    )
    _remove_temporary_database(temporary_database_path)
    try:
        with (
            closing(connect_database(database_path)) as source,
            closing(connect_database(temporary_database_path)) as destination,
        ):
            source.backup(destination)
            destination.execute("PRAGMA journal_mode = DELETE")

        embedded = _populate_visual_index(
            temporary_database_path,
            data_dir,
            encoder,
            dimension=dimension,
            batch_size=batch_size,
        )
        with closing(connect_database(temporary_database_path)) as connection:
            integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise RuntimeError(f"SQLite integrity check failed: {integrity}")

        os.replace(temporary_database_path, database_path)
        return embedded
    finally:
        _remove_temporary_database(temporary_database_path)


def _populate_visual_index(
    database_path: Path,
    data_dir: Path,
    encoder: ImageEncoder,
    *,
    dimension: int,
    batch_size: int,
) -> int:
    with closing(connect_database(database_path)) as connection, connection:
        connection.execute("DROP TABLE IF EXISTS clip_embeddings")
        connection.execute(embeddings_schema(dimension * 4))
        rows = connection.execute(
            "SELECT id, original_path FROM samples ORDER BY id"
        ).fetchall()

        embedded = 0
        for start in range(0, len(rows), batch_size):
            batch = rows[start : start + batch_size]
            images = [_load_rgb_image(data_dir / row["original_path"]) for row in batch]
            vectors = np.ascontiguousarray(
                encoder.encode_images(images), dtype=VECTOR_DTYPE
            )
            if vectors.shape != (len(batch), dimension):
                raise ValueError(
                    f"Encoder returned vectors of shape {vectors.shape}; "
                    f"expected {(len(batch), dimension)}"
                )
            connection.executemany(
                "INSERT INTO clip_embeddings (sample_id, vector) VALUES (?, ?)",
                [
                    (row["id"], vector.tobytes())
                    for row, vector in zip(batch, vectors, strict=True)
                ],
            )
            embedded += len(batch)
            if embedded % 512 == 0 or embedded == len(rows):
                LOGGER.info("Embedded %s of %s images", embedded, len(rows))
        return embedded


def _remove_temporary_database(path: Path) -> None:
    for suffix in ("", "-journal", "-shm", "-wal"):
        Path(f"{path}{suffix}").unlink(missing_ok=True)


def _load_rgb_image(path: Path) -> Image.Image:
    with Image.open(path) as image:
        return ImageOps.exif_transpose(image).convert("RGB")


def invalidate_visual_ready(data_dir: Path) -> None:
    """Unpublish the visual index; call when replacing the base database."""
    Settings.for_data_dir(data_dir).visual_ready_path.unlink(missing_ok=True)


def prepare_visual_search(data_dir: Path, *, force: bool = False) -> dict[str, Any]:
    """Download the pinned model and build the visual index; idempotent."""
    from .clip_encoder import ClipEncoder, download_model_files

    dataset_lock = load_dataset_lock()
    model_lock = load_model_lock()
    settings = Settings.for_data_dir(data_dir)
    data_dir = settings.data_dir
    manifest_path = settings.visual_manifest_path
    ready_path = settings.visual_ready_path

    download_model_files(model_lock, settings.model_dir)
    if not force and _visual_index_is_current(
        settings.database_path, manifest_path, ready_path
    ):
        LOGGER.info(
            "Visual search index for model revision %s is already prepared",
            model_lock.revision,
        )
        return json.loads(manifest_path.read_text(encoding="utf-8"))

    encoder = ClipEncoder(settings.model_dir, model_lock)
    sample_count = build_visual_index(
        settings.database_path,
        data_dir,
        encoder,
        dimension=model_lock.embedding_dimension,
    )
    return write_visual_manifest(
        manifest_path,
        ready_path,
        sample_count=sample_count,
        model_lock=model_lock,
        dataset_lock=dataset_lock,
    )


def write_visual_manifest(
    manifest_path: Path,
    ready_path: Path,
    *,
    sample_count: int,
    model_lock: ClipModelLock | None = None,
    dataset_lock: DatasetLock | None = None,
) -> dict[str, Any]:
    model_lock = model_lock or load_model_lock()
    dataset_lock = dataset_lock or load_dataset_lock()
    manifest = {
        "schema_version": VISUAL_MANIFEST_SCHEMA_VERSION,
        "model": {"repo_id": model_lock.repo_id, "revision": model_lock.revision},
        "embedding_dimension": model_lock.embedding_dimension,
        "preprocessing_version": model_lock.preprocessing_version,
        "dataset_revision": dataset_lock.revision,
        "sample_count": sample_count,
        "built_at": datetime.now(UTC).isoformat(),
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    write_atomic(manifest_path, json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    write_atomic(ready_path, _ready_identity(model_lock, dataset_lock))
    return manifest


def visual_identity_matches_locks(manifest_path: Path, ready_path: Path) -> bool:
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        ready_text = ready_path.read_text(encoding="utf-8")
        model_lock = load_model_lock()
        dataset_lock = load_dataset_lock()
    except (OSError, json.JSONDecodeError, RuntimeError):
        return False

    return (
        isinstance(manifest, Mapping)
        and manifest.get("schema_version") == VISUAL_MANIFEST_SCHEMA_VERSION
        and manifest.get("model")
        == {"repo_id": model_lock.repo_id, "revision": model_lock.revision}
        and manifest.get("embedding_dimension") == model_lock.embedding_dimension
        and manifest.get("preprocessing_version") == model_lock.preprocessing_version
        and manifest.get("dataset_revision") == dataset_lock.revision
        and ready_text == _ready_identity(model_lock, dataset_lock)
    )


@contextmanager
def _visual_connection(database_path: Path) -> Iterator[sqlite3.Connection]:
    """Open the database for a visual query.

    Only a missing embeddings table means the visual index is absent; any
    other failure means the database itself is not ready.
    """
    try:
        with open_database(database_path) as connection:
            yield connection
    except DatabaseUnavailableError as error:
        cause = error.__cause__
        if isinstance(cause, sqlite3.OperationalError) and (
            "no such table: clip_embeddings" in str(cause)
        ):
            raise VisualIndexUnavailableError(
                "Visual search index is missing"
            ) from cause
        raise


def load_embedding(database_path: Path, sample_id: str) -> np.ndarray | None:
    """Stored embedding for one sample, or None when the sample is unknown.

    Lets a sample's own image act as the ranking query without loading the
    text encoder.
    """
    with _visual_connection(database_path) as connection:
        return _read_embedding(connection, sample_id)


def _read_embedding(
    connection: sqlite3.Connection, sample_id: str
) -> np.ndarray | None:
    """The stored embedding, or None for an unknown sample.

    A known sample without one means the index is incomplete, which is a
    visual-index failure rather than a missing sample.
    """
    row = connection.execute(
        """
        SELECT clip_embeddings.vector
        FROM samples
        LEFT JOIN clip_embeddings ON clip_embeddings.sample_id = samples.id
        WHERE samples.id = ?
        """,
        (sample_id,),
    ).fetchone()
    if row is None:
        return None
    if row["vector"] is None:
        raise VisualIndexUnavailableError(f"Sample {sample_id} has no stored embedding")
    return np.frombuffer(row["vector"], dtype=VECTOR_DTYPE)


def rank_samples(
    database_path: Path,
    query_vector: np.ndarray,
    *,
    filters: SampleFilters,
    limit: int,
    offset: int,
) -> tuple[int, list[dict[str, Any]]]:
    """Rank every sample matching the filters by cosine similarity, paginated.

    Ranking never changes which samples match, only their order, which is
    deterministic: similarity descending, then sample ID ascending.
    """
    with _visual_connection(database_path) as connection:
        ranked = _rank_filtered_samples(connection, filters, query_vector)
        records = _load_page_records(
            connection, ranked[offset : offset + limit], filters=filters
        )

    return len(ranked), records


def rank_neighbors(
    database_path: Path,
    query_vector: np.ndarray,
    *,
    filters: SampleFilters,
    sample_id: str,
) -> dict[str, Any]:
    """Ranked-order neighbors and similarity for one sample.

    Mirrors the stable-ID neighbor semantics: a sample outside the filtered
    set gets no neighbors, but its own similarity is still reported.
    """
    with _visual_connection(database_path) as connection:
        ranked = _rank_filtered_samples(connection, filters, query_vector)
        position = next(
            (
                index
                for index, (ranked_id, _) in enumerate(ranked)
                if ranked_id == sample_id
            ),
            None,
        )
        if position is None:
            vector = _read_embedding(connection, sample_id)
            query = np.asarray(query_vector, dtype=np.float32)
            if vector is not None and vector.shape != query.shape:
                raise VisualIndexUnavailableError(
                    "Stored embeddings do not match the query dimension"
                )
            return {
                "previous_id": None,
                "next_id": None,
                "similarity": None if vector is None else float(vector @ query),
            }

    return {
        "previous_id": ranked[position - 1][0] if position > 0 else None,
        "next_id": ranked[position + 1][0] if position + 1 < len(ranked) else None,
        "similarity": ranked[position][1],
    }


def _rank_filtered_samples(
    connection: sqlite3.Connection,
    filters: SampleFilters,
    query_vector: np.ndarray,
) -> list[tuple[str, float]]:
    clauses, parameters = filter_clauses(filters)
    rows = connection.execute(
        f"""
        SELECT samples.id, clip_embeddings.vector
        FROM samples
        LEFT JOIN clip_embeddings ON clip_embeddings.sample_id = samples.id
        {compose_where_clause(clauses)}
        """,
        parameters,
    ).fetchall()
    return _rank_by_similarity(rows, query_vector)


def _rank_by_similarity(
    rows: list[sqlite3.Row], query_vector: np.ndarray
) -> list[tuple[str, float]]:
    if not rows:
        return []

    vectors: list[np.ndarray] = []
    for row in rows:
        if row["vector"] is None:
            raise VisualIndexUnavailableError(
                f"Sample {row['id']} has no stored embedding"
            )
        vectors.append(np.frombuffer(row["vector"], dtype=VECTOR_DTYPE))

    matrix = np.stack(vectors)
    query = np.asarray(query_vector, dtype=np.float32)
    if matrix.shape[1] != query.shape[-1]:
        raise VisualIndexUnavailableError(
            "Stored embeddings do not match the query dimension"
        )

    similarities = matrix @ query
    return sorted(
        (
            (row["id"], float(similarity))
            for row, similarity in zip(rows, similarities, strict=True)
        ),
        key=lambda item: (-item[1], item[0]),
    )


def _load_page_records(
    connection: sqlite3.Connection,
    page: list[tuple[str, float]],
    *,
    filters: SampleFilters,
) -> list[dict[str, Any]]:
    records = load_summary_records(
        connection, [sample_id for sample_id, _ in page], filters=filters
    )
    return [
        {**record, "similarity": similarity}
        for record, (_, similarity) in zip(records, page, strict=True)
    ]


def _visual_index_is_current(
    database_path: Path, manifest_path: Path, ready_path: Path
) -> bool:
    if not visual_identity_matches_locks(manifest_path, ready_path):
        return False
    try:
        with closing(connect_database(database_path)) as connection:
            missing = connection.execute(
                """
                SELECT COUNT(*)
                FROM samples
                LEFT JOIN clip_embeddings ON clip_embeddings.sample_id = samples.id
                WHERE clip_embeddings.sample_id IS NULL
                """
            ).fetchone()[0]
    except sqlite3.Error:
        return False
    return missing == 0


def _ready_identity(model_lock: ClipModelLock, dataset_lock: DatasetLock) -> str:
    return (
        f"{model_lock.revision}:{model_lock.preprocessing_version}"
        f":{dataset_lock.revision}\n"
    )
