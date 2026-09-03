import hashlib
import json
import logging
import sys
from contextlib import closing
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np
import pytest
from conftest import write_prepared_identity
from fastapi.testclient import TestClient
from PIL import Image

from flickr8k_visualizer import clip_encoder as clip_encoder_module
from flickr8k_visualizer import download as download_module
from flickr8k_visualizer import visual_search as visual_search_module
from flickr8k_visualizer.clip_encoder import (
    ClipEncoder,
    ModelFilesMissingError,
    download_model_files,
)
from flickr8k_visualizer.config import REPOSITORY_ROOT, Settings
from flickr8k_visualizer.db import connect_database, initialize_database
from flickr8k_visualizer.download import verify_file
from flickr8k_visualizer.main import (
    _LazyTextEncoder,
    _load_clip_text_encoder,
    create_app,
)
from flickr8k_visualizer.model_lock import ClipModelLock, ModelFile, load_model_lock
from flickr8k_visualizer.visual_search import (
    _rank_by_similarity,
    build_visual_index,
    embeddings_schema,
    prepare_visual_search,
    visual_identity_matches_locks,
    write_visual_manifest,
)

TRACKED_MODEL_LOCK_PATH = REPOSITORY_ROOT / "models" / "clip.lock.json"

# Two-dimensional unit vectors keep the expected cosine ranking obvious:
# sample-a and sample-b are identical to exercise stable-ID tie-breaking.
SAMPLE_VECTORS = {
    "sample-a": [1.0, 0.0],
    "sample-b": [1.0, 0.0],
    "sample-c": [0.6, 0.8],
    "sample-d": [0.0, 1.0],
}
SAMPLE_SPLITS = {
    "sample-b": "train",
    "sample-a": "train",
    "sample-c": "train",
    "sample-d": "test",
}
TEXT_VECTORS = {
    "right": [1.0, 0.0],
    "up": [0.0, 1.0],
    "wrong dimension": [1.0, 0.0, 0.0],
}


class FakeTextEncoder:
    def __init__(self, vectors: dict[str, list[float]]) -> None:
        self._vectors = vectors

    def encode_text(self, text: str) -> np.ndarray:
        return np.asarray(self._vectors[text], dtype=np.float32)


class FakeImageEncoder:
    """Encodes each image as its normalized (width, height); records inputs."""

    def __init__(self) -> None:
        self.received: list[tuple[str, tuple[int, int]]] = []

    def encode_images(self, images: list[Image.Image]) -> np.ndarray:
        self.received.extend((image.mode, image.size) for image in images)
        vectors = np.asarray(
            [[image.width, image.height] for image in images], dtype=np.float32
        )
        return vectors / np.linalg.norm(vectors, axis=1, keepdims=True)


def _prepare_visual_settings(tmp_path: Path) -> Settings:
    data_dir = tmp_path / "data"
    database_path = data_dir / "flickr8k.sqlite3"
    write_prepared_identity(data_dir)
    initialize_database(database_path)
    with closing(connect_database(database_path)) as connection, connection:
        connection.executemany(
            """
            INSERT INTO samples (
                id, source_id, split, content_sha256, width, height,
                mime_type, file_size_bytes, original_path, thumbnail_path
            ) VALUES (?, ?, ?, ?, ?, ?, 'image/jpeg', 10, ?, ?)
            """,
            [
                (
                    sample_id,
                    f"{sample_id}.jpg",
                    split,
                    sample_id[-1] * 64,
                    500,
                    375,
                    f"images/{sample_id}.jpg",
                    f"thumbnails/{sample_id}.webp",
                )
                for sample_id, split in SAMPLE_SPLITS.items()
            ],
        )
        connection.executemany(
            "INSERT INTO captions (sample_id, position, text) VALUES (?, ?, ?)",
            [
                ("sample-a", 0, "First caption of sample a."),
                ("sample-a", 1, "Second caption of sample a."),
                ("sample-b", 0, "A caption for sample b."),
                ("sample-c", 0, "A caption for sample c."),
                ("sample-d", 0, "A caption for sample d."),
            ],
        )
        connection.execute(embeddings_schema(2 * 4))
        connection.executemany(
            "INSERT INTO clip_embeddings (sample_id, vector) VALUES (?, ?)",
            [
                (sample_id, np.asarray(vector, dtype="<f4").tobytes())
                for sample_id, vector in SAMPLE_VECTORS.items()
            ],
        )

    settings = Settings(
        data_dir=data_dir,
        database_path=database_path,
        manifest_path=data_dir / "manifest.json",
        cors_origins=(),
    )
    write_visual_manifest(
        settings.visual_manifest_path,
        settings.visual_ready_path,
        sample_count=len(SAMPLE_VECTORS),
    )
    return settings


def _make_client(settings: Settings) -> TestClient:
    app = create_app(
        settings, text_encoder_factory=lambda: FakeTextEncoder(TEXT_VECTORS)
    )
    return TestClient(app)


@pytest.fixture
def visual_settings(tmp_path: Path) -> Settings:
    return _prepare_visual_settings(tmp_path)


def test_rank_orders_samples_by_similarity_descending(
    visual_settings: Settings,
) -> None:
    with _make_client(visual_settings) as client:
        response = client.get("/api/samples", params={"rank": "up"})

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 4
    assert [item["id"] for item in body["items"]] == [
        "sample-d",
        "sample-c",
        "sample-a",
        "sample-b",
    ]
    assert body["items"][0]["similarity"] == pytest.approx(1.0)
    assert body["items"][1]["similarity"] == pytest.approx(0.8)


def test_rank_breaks_similarity_ties_by_sample_id() -> None:
    vector = np.asarray([1.0, 0.0], dtype="<f4").tobytes()
    rows = [
        {"id": "sample-b", "vector": vector},
        {"id": "sample-a", "vector": vector},
    ]

    ranked = _rank_by_similarity(rows, np.asarray([1.0, 0.0], dtype=np.float32))

    assert [sample_id for sample_id, _ in ranked] == ["sample-a", "sample-b"]
    assert ranked[0][1] == pytest.approx(ranked[1][1])


def test_lazy_text_encoder_reloads_when_the_model_revision_changes() -> None:
    encoders = [FakeTextEncoder(TEXT_VECTORS), FakeTextEncoder(TEXT_VECTORS)]
    created: list[FakeTextEncoder] = []

    def factory() -> FakeTextEncoder:
        encoder = encoders[len(created)]
        created.append(encoder)
        return encoder

    cache = _LazyTextEncoder(factory)

    assert cache.get("a" * 40) is encoders[0]
    assert cache.get("a" * 40) is encoders[0]
    assert cache.get("b" * 40) is encoders[1]
    assert created == encoders


def test_rank_scopes_to_the_split_filter_before_ranking(
    visual_settings: Settings,
) -> None:
    with _make_client(visual_settings) as client:
        train = client.get("/api/samples", params={"rank": "up", "split": "train"})
        test = client.get("/api/samples", params={"rank": "up", "split": "test"})
        empty = client.get("/api/samples", params={"rank": "up", "split": "validation"})

    assert train.status_code == 200
    assert train.json()["total"] == 3
    assert [item["id"] for item in train.json()["items"]] == [
        "sample-c",
        "sample-a",
        "sample-b",
    ]
    assert [item["id"] for item in test.json()["items"]] == ["sample-d"]
    assert empty.json() == {
        "total": 0,
        "limit": 24,
        "offset": 0,
        "visual_ranking_ready": True,
        "items": [],
    }


def test_rank_composes_with_the_term_filter(visual_settings: Settings) -> None:
    with _make_client(visual_settings) as client:
        response = client.get("/api/samples", params={"rank": "up", "term": "first"})

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    assert [item["id"] for item in body["items"]] == ["sample-a"]
    assert body["items"][0]["similarity"] == pytest.approx(0.0)


def test_rank_composes_with_caption_search_and_keeps_matches(
    visual_settings: Settings,
) -> None:
    with _make_client(visual_settings) as client:
        response = client.get("/api/samples", params={"rank": "up", "q": "caption for"})

    assert response.status_code == 200
    body = response.json()
    # The caption filter selects b, c, d; ranking only reorders them.
    assert body["total"] == 3
    assert [item["id"] for item in body["items"]] == [
        "sample-d",
        "sample-c",
        "sample-b",
    ]
    assert body["items"][0]["matched_captions"] == ["A caption for sample d."]
    assert body["items"][0]["similarity"] == pytest.approx(1.0)


def test_rank_composes_with_the_word_count_filter(visual_settings: Settings) -> None:
    with _make_client(visual_settings) as client:
        matching = client.get("/api/samples", params={"rank": "up", "min_words": 5})
        empty = client.get("/api/samples", params={"rank": "up", "min_words": 6})

    assert matching.json()["total"] == 4
    assert matching.json()["items"][0]["id"] == "sample-d"
    assert empty.json()["total"] == 0


def test_rank_paginates_after_ranking(visual_settings: Settings) -> None:
    with _make_client(visual_settings) as client:
        response = client.get(
            "/api/samples", params={"rank": "up", "limit": 2, "offset": 1}
        )

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 4
    assert body["limit"] == 2
    assert body["offset"] == 1
    # Full ranking is d, c, a, b; the page starts after the top result.
    assert [item["id"] for item in body["items"]] == ["sample-c", "sample-a"]


def test_rank_context_gives_ranked_detail_neighbors(
    visual_settings: Settings,
) -> None:
    with _make_client(visual_settings) as client:
        middle = client.get("/api/samples/sample-c", params={"rank": "up"})
        first = client.get("/api/samples/sample-d", params={"rank": "up"})
        last = client.get("/api/samples/sample-b", params={"rank": "up"})

    # Ranked order for "up" is d, c, a, b.
    assert middle.status_code == 200
    assert middle.json()["previous_id"] == "sample-d"
    assert middle.json()["next_id"] == "sample-a"
    assert middle.json()["similarity"] == pytest.approx(0.8)
    assert first.json()["previous_id"] is None
    assert first.json()["next_id"] == "sample-c"
    assert last.json()["previous_id"] == "sample-a"
    assert last.json()["next_id"] is None


def test_ranked_detail_neighbors_respect_filters(visual_settings: Settings) -> None:
    with _make_client(visual_settings) as client:
        response = client.get(
            "/api/samples/sample-a", params={"rank": "up", "split": "train"}
        )

    # The ranked train-only order is c, a, b.
    assert response.status_code == 200
    assert response.json()["previous_id"] == "sample-c"
    assert response.json()["next_id"] == "sample-b"


def test_ranked_detail_outside_filters_keeps_similarity_without_neighbors(
    visual_settings: Settings,
) -> None:
    with _make_client(visual_settings) as client:
        response = client.get(
            "/api/samples/sample-d", params={"rank": "up", "split": "train"}
        )

    assert response.status_code == 200
    body = response.json()
    assert body["previous_id"] is None
    assert body["next_id"] is None
    assert body["similarity"] == pytest.approx(1.0)


def test_detail_without_rank_context_has_no_similarity(
    visual_settings: Settings,
) -> None:
    with _make_client(visual_settings) as client:
        response = client.get("/api/samples/sample-c")

    assert response.status_code == 200
    assert response.json()["similarity"] is None
    assert response.json()["previous_id"] == "sample-b"


def test_detail_rejects_an_invalid_rank(visual_settings: Settings) -> None:
    with _make_client(visual_settings) as client:
        assert (
            client.get("/api/samples/sample-c", params={"rank": ""}).status_code == 422
        )


def test_health_reports_visual_ranking_readiness(visual_settings: Settings) -> None:
    with _make_client(visual_settings) as client:
        ready = client.get("/api/health")

    visual_settings.visual_ready_path.write_text("stale\n", encoding="utf-8")
    with _make_client(visual_settings) as client:
        stale = client.get("/api/health")

    assert ready.json() == {"status": "ok", "visual_ranking_ready": True}
    assert stale.json() == {"status": "ok", "visual_ranking_ready": False}


def test_rank_keeps_matches_for_the_term_filter(visual_settings: Settings) -> None:
    with _make_client(visual_settings) as client:
        response = client.get("/api/samples", params={"rank": "up", "term": "first"})

    assert response.status_code == 200
    items = response.json()["items"]
    assert [(item["id"], item["matched_captions"]) for item in items] == [
        ("sample-a", ["First caption of sample a."]),
    ]


def test_rank_returns_ordinary_captions_without_matches(
    visual_settings: Settings,
) -> None:
    with _make_client(visual_settings) as client:
        response = client.get("/api/samples", params={"rank": "right"})

    assert response.status_code == 200
    first = response.json()["items"][0]
    assert first == {
        "id": "sample-a",
        "source_id": "sample-a.jpg",
        "split": "train",
        "width": 500,
        "height": 375,
        "thumbnail_url": "/media/thumbnails/sample-a.webp",
        "caption": "First caption of sample a.",
        "matched_captions": [],
        "duplicate": False,
        "similarity": pytest.approx(1.0),
    }


def test_rank_trims_the_description(visual_settings: Settings) -> None:
    with _make_client(visual_settings) as client:
        response = client.get("/api/samples", params={"rank": "  up  "})

    assert response.status_code == 200
    assert response.json()["items"][0]["id"] == "sample-d"


@pytest.mark.parametrize(
    "params",
    [
        {"rank": ""},
        {"rank": "   "},
        {"rank": "a" * 201},
        {"rank": "up", "limit": 0},
        {"rank": "up", "limit": 101},
        {"rank": "up", "offset": -1},
        {"rank": "up", "split": "development"},
    ],
    ids=[
        "empty-rank",
        "whitespace-rank",
        "too-long-rank",
        "zero-limit",
        "limit-above-maximum",
        "negative-offset",
        "unknown-split",
    ],
)
def test_rank_rejects_invalid_parameters(
    visual_settings: Settings, params: dict[str, object]
) -> None:
    with _make_client(visual_settings) as client:
        assert client.get("/api/samples", params=params).status_code == 422


def test_rank_unavailable_without_visual_manifest(tmp_path: Path) -> None:
    settings = _prepare_visual_settings(tmp_path)
    settings.visual_manifest_path.unlink()

    with _make_client(settings) as client:
        ranked_response = client.get("/api/samples", params={"rank": "up"})
        plain_response = client.get("/api/samples")
        ranked_detail = client.get("/api/samples/sample-c", params={"rank": "up"})
        plain_detail = client.get("/api/samples/sample-c")

    assert ranked_response.status_code == 503
    assert ranked_response.json() == {
        "detail": "Visual search is not prepared. Run the data preparation command."
    }
    assert plain_response.status_code == 200
    assert plain_response.json()["visual_ranking_ready"] is False
    assert ranked_detail.status_code == 503
    assert plain_detail.status_code == 200


def test_rank_unavailable_with_stale_model_identity(tmp_path: Path) -> None:
    settings = _prepare_visual_settings(tmp_path)
    manifest = json.loads(settings.visual_manifest_path.read_text(encoding="utf-8"))
    manifest["model"]["revision"] = "0" * 40
    settings.visual_manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with _make_client(settings) as client:
        assert client.get("/api/samples", params={"rank": "up"}).status_code == 503


def test_rank_unavailable_with_stale_ready_marker(tmp_path: Path) -> None:
    settings = _prepare_visual_settings(tmp_path)
    settings.visual_ready_path.write_text("stale\n", encoding="utf-8")

    with _make_client(settings) as client:
        ranked_response = client.get("/api/samples", params={"rank": "up"})
        plain_response = client.get("/api/samples")

    assert ranked_response.status_code == 503
    assert plain_response.status_code == 200


def test_rank_unavailable_when_coverage_is_incomplete(tmp_path: Path) -> None:
    settings = _prepare_visual_settings(tmp_path)
    with closing(connect_database(settings.database_path)) as connection, connection:
        connection.execute("DELETE FROM clip_embeddings WHERE sample_id = 'sample-c'")

    with _make_client(settings) as client:
        assert client.get("/api/samples", params={"rank": "up"}).status_code == 503


def test_incomplete_coverage_is_unavailable_from_every_ranking_path(
    tmp_path: Path,
) -> None:
    settings = _prepare_visual_settings(tmp_path)
    with closing(connect_database(settings.database_path)) as connection, connection:
        connection.execute("DELETE FROM clip_embeddings WHERE sample_id = 'sample-d'")

    with _make_client(settings) as client:
        # sample-d sits outside the train filter, so its similarity comes from
        # the single-sample fallback rather than the ranked listing.
        detail = client.get(
            "/api/samples/sample-d", params={"rank": "up", "split": "train"}
        )
        reference = client.get("/api/samples", params={"similar_to": "sample-d"})

    assert detail.status_code == 503
    assert reference.status_code == 503


def test_rank_unavailable_without_embeddings_table(tmp_path: Path) -> None:
    settings = _prepare_visual_settings(tmp_path)
    with closing(connect_database(settings.database_path)) as connection, connection:
        connection.execute("DROP TABLE clip_embeddings")

    with _make_client(settings) as client:
        ranked_response = client.get("/api/samples", params={"rank": "up"})
        plain_response = client.get("/api/samples")

    assert ranked_response.status_code == 503
    assert plain_response.status_code == 200


def test_rank_unavailable_when_encoder_fails_to_load(
    visual_settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    """Corrupt or unloadable model files must give the documented 503."""

    def broken_factory() -> FakeTextEncoder:
        raise RuntimeError("could not deserialize model.safetensors")

    app = create_app(visual_settings, text_encoder_factory=broken_factory)
    with (
        caplog.at_level(logging.ERROR, logger="flickr8k_visualizer.main"),
        TestClient(app) as client,
    ):
        response = client.get("/api/samples", params={"rank": "up"})

    assert response.status_code == 503
    assert response.json() == {
        "detail": "Visual search is not prepared. Run the data preparation command."
    }
    assert "Failed to load the CLIP text encoder" in caplog.text
    assert "could not deserialize model.safetensors" in caplog.text


def test_rank_inference_failures_are_not_reported_as_unprepared(
    visual_settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    """A loaded encoder failing at inference is not a preparation problem, so
    the response must not tell the user to rerun data preparation."""

    class ExplodingEncoder:
        def encode_text(self, text: str) -> np.ndarray:
            raise RuntimeError("tokenizer state is corrupt")

    app = create_app(visual_settings, text_encoder_factory=ExplodingEncoder)
    with (
        caplog.at_level(logging.ERROR, logger="flickr8k_visualizer.main"),
        TestClient(app) as client,
    ):
        response = client.get("/api/samples", params={"rank": "up"})

    assert response.status_code == 500
    assert response.json() == {
        "detail": "Visual ranking failed while encoding the description. "
        "See the API log for details."
    }
    assert "Failed to encode the rank description" in caplog.text


def test_rank_unavailable_on_query_dimension_mismatch(
    visual_settings: Settings,
) -> None:
    with _make_client(visual_settings) as client:
        response = client.get("/api/samples", params={"rank": "wrong dimension"})

    assert response.status_code == 503


def test_visual_identity_round_trip_and_tampering(tmp_path: Path) -> None:
    manifest_path = tmp_path / "manifest.json"
    ready_path = tmp_path / ".ready"

    assert not visual_identity_matches_locks(manifest_path, ready_path)
    write_visual_manifest(manifest_path, ready_path, sample_count=4)
    assert visual_identity_matches_locks(manifest_path, ready_path)

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["schema_version"] = 999
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    assert not visual_identity_matches_locks(manifest_path, ready_path)

    write_visual_manifest(manifest_path, ready_path, sample_count=4)
    ready_path.write_text("tampered\n", encoding="utf-8")
    assert not visual_identity_matches_locks(manifest_path, ready_path)


def _ingested_database(data_dir: Path, samples: list[tuple[str, bytes]]) -> Path:
    """Create a database plus image files for the given (id, bytes) samples."""
    database_path = data_dir / "flickr8k.sqlite3"
    initialize_database(database_path)
    images_dir = data_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    with closing(connect_database(database_path)) as connection, connection:
        for sample_id, image_bytes in samples:
            (images_dir / f"{sample_id}.img").write_bytes(image_bytes)
            connection.execute(
                """
                INSERT INTO samples (
                    id, source_id, split, content_sha256, width, height,
                    mime_type, file_size_bytes, original_path, thumbnail_path
                ) VALUES (?, ?, 'train', ?, 1, 1, 'image/jpeg', 1, ?, ?)
                """,
                (
                    sample_id,
                    f"{sample_id}.jpg",
                    sample_id[-1] * 64,
                    f"images/{sample_id}.img",
                    f"thumbnails/{sample_id}.webp",
                ),
            )
    return database_path


def _image_bytes(
    size: tuple[int, int],
    *,
    image_format: str = "JPEG",
    mode: str = "RGB",
    orientation: int | None = None,
) -> bytes:
    output = BytesIO()
    image = Image.new(mode, size)
    exif = Image.Exif()
    if orientation is not None:
        exif[274] = orientation
    image.save(output, format=image_format, exif=exif)
    return output.getvalue()


def test_build_visual_index_embeds_every_sample_in_id_order(tmp_path: Path) -> None:
    database_path = _ingested_database(
        tmp_path,
        [
            ("sample-c", _image_bytes((5, 5))),
            ("sample-b", _image_bytes((3, 4))),
            ("sample-a", _image_bytes((4, 3))),
        ],
    )
    encoder = FakeImageEncoder()

    embedded = build_visual_index(
        database_path, tmp_path, encoder, dimension=2, batch_size=2
    )

    assert embedded == 3
    assert [size for _, size in encoder.received] == [(4, 3), (3, 4), (5, 5)]
    with closing(connect_database(database_path)) as connection:
        rows = connection.execute(
            "SELECT sample_id, vector FROM clip_embeddings ORDER BY sample_id"
        ).fetchall()
    assert [row["sample_id"] for row in rows] == ["sample-a", "sample-b", "sample-c"]
    stored = np.frombuffer(rows[0]["vector"], dtype="<f4")
    assert stored == pytest.approx([0.8, 0.6])


def test_build_visual_index_applies_exif_orientation_and_rgb(tmp_path: Path) -> None:
    database_path = _ingested_database(
        tmp_path,
        [
            ("sample-a", _image_bytes((6, 4), orientation=6)),
            ("sample-b", _image_bytes((2, 2), image_format="PNG", mode="RGBA")),
        ],
    )
    encoder = FakeImageEncoder()

    build_visual_index(database_path, tmp_path, encoder, dimension=2)

    # Orientation 6 rotates the 6x4 image to 4x6; RGBA converts to RGB.
    assert encoder.received == [("RGB", (4, 6)), ("RGB", (2, 2))]


def test_build_visual_index_does_not_lock_the_live_database(tmp_path: Path) -> None:
    database_path = _ingested_database(tmp_path, [("sample-a", _image_bytes((4, 3)))])

    class LockCheckingEncoder(FakeImageEncoder):
        def encode_images(self, images: list[Image.Image]) -> np.ndarray:
            with closing(connect_database(database_path)) as live_connection:
                live_connection.execute("PRAGMA busy_timeout = 0")
                live_connection.execute("BEGIN IMMEDIATE")
                live_connection.rollback()
            return super().encode_images(images)

    build_visual_index(database_path, tmp_path, LockCheckingEncoder(), dimension=2)


def test_build_visual_index_rejects_unexpected_vector_shapes(tmp_path: Path) -> None:
    database_path = _ingested_database(tmp_path, [("sample-a", _image_bytes((4, 3)))])

    class WrongShapeEncoder:
        def encode_images(self, images: list[Image.Image]) -> np.ndarray:
            return np.zeros((len(images), 3), dtype=np.float32)

    with pytest.raises(ValueError, match="expected"):
        build_visual_index(database_path, tmp_path, WrongShapeEncoder(), dimension=2)


def test_failed_rebuild_keeps_the_previous_index_intact(tmp_path: Path) -> None:
    database_path = _ingested_database(tmp_path, [("sample-a", _image_bytes((4, 3)))])
    build_visual_index(database_path, tmp_path, FakeImageEncoder(), dimension=2)

    class FailingEncoder:
        def encode_images(self, images: list[Image.Image]) -> np.ndarray:
            raise RuntimeError("encoder crashed mid-build")

    with pytest.raises(RuntimeError, match="crashed"):
        build_visual_index(database_path, tmp_path, FailingEncoder(), dimension=2)

    with closing(connect_database(database_path)) as connection:
        rows = connection.execute(
            "SELECT sample_id, vector FROM clip_embeddings"
        ).fetchall()
    assert [row["sample_id"] for row in rows] == ["sample-a"]
    assert np.frombuffer(rows[0]["vector"], dtype="<f4") == pytest.approx([0.8, 0.6])
    assert list(tmp_path.glob(".flickr8k.sqlite3.visual-search*")) == []


def _fixture_model_lock(model_dir: Path, contents: bytes) -> ClipModelLock:
    return ClipModelLock(
        repo_id="fixture/clip",
        revision="a" * 40,
        embedding_dimension=2,
        preprocessing_version=1,
        files=(
            ModelFile(
                path="weights.bin",
                size_bytes=len(contents),
                sha256=hashlib.sha256(contents).hexdigest(),
            ),
        ),
    )


def test_preparation_repairs_a_missing_model_without_rebuilding_the_index(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    data_dir = tmp_path / "data"
    database_path = _ingested_database(data_dir, [("sample-a", _image_bytes((4, 3)))])
    settings = Settings(
        data_dir=data_dir,
        database_path=database_path,
        manifest_path=data_dir / "manifest.json",
    )
    model_contents = b"model weights"
    model_lock = _fixture_model_lock(settings.model_dir, model_contents)
    settings.model_dir.mkdir(parents=True)
    (settings.model_dir / "weights.bin").write_bytes(model_contents)
    build_visual_index(database_path, data_dir, FakeImageEncoder(), dimension=2)
    write_visual_manifest(
        settings.visual_manifest_path,
        settings.visual_ready_path,
        sample_count=1,
        model_lock=model_lock,
    )
    (settings.model_dir / "weights.bin").unlink()
    settings.model_dir.rmdir()

    downloads: list[Path] = []

    def fake_download(_model_lock: ClipModelLock, model_dir: Path) -> None:
        downloads.append(model_dir)
        model_dir.mkdir(parents=True)
        (model_dir / "weights.bin").write_bytes(model_contents)

    def unexpected_encoder(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("a current index must not reload the image encoder")

    def unexpected_build(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("a current index must not be rebuilt")

    monkeypatch.setattr(visual_search_module, "load_model_lock", lambda: model_lock)
    monkeypatch.setattr(clip_encoder_module, "download_model_files", fake_download)
    monkeypatch.setattr(clip_encoder_module, "ClipEncoder", unexpected_encoder)
    monkeypatch.setattr(visual_search_module, "build_visual_index", unexpected_build)

    manifest = prepare_visual_search(data_dir)

    assert downloads == [settings.model_dir]
    assert (settings.model_dir / "weights.bin").read_bytes() == model_contents
    assert manifest["sample_count"] == 1


def test_prepare_visual_search_builds_and_publishes_the_index(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The real build-and-publish branch, end to end with a fake encoder."""
    data_dir = tmp_path / "data"
    database_path = _ingested_database(
        data_dir,
        [("sample-a", _image_bytes((4, 3))), ("sample-b", _image_bytes((3, 4)))],
    )
    settings = Settings(
        data_dir=data_dir,
        database_path=database_path,
        manifest_path=data_dir / "manifest.json",
    )
    model_contents = b"model weights"
    model_lock = _fixture_model_lock(settings.model_dir, model_contents)
    settings.model_dir.mkdir(parents=True)
    (settings.model_dir / "weights.bin").write_bytes(model_contents)
    monkeypatch.setattr(visual_search_module, "load_model_lock", lambda: model_lock)
    monkeypatch.setattr(
        clip_encoder_module,
        "ClipEncoder",
        lambda _model_dir, _model_lock: FakeImageEncoder(),
    )

    manifest = prepare_visual_search(data_dir)

    assert manifest["sample_count"] == 2
    assert visual_identity_matches_locks(
        settings.visual_manifest_path, settings.visual_ready_path
    )
    with closing(connect_database(database_path)) as connection:
        rows = connection.execute(
            "SELECT sample_id, length(vector) AS nbytes"
            " FROM clip_embeddings ORDER BY sample_id"
        ).fetchall()
    # Vector length pins the build to the lock's embedding dimension (2 * 4).
    assert [(row["sample_id"], row["nbytes"]) for row in rows] == [
        ("sample-a", 8),
        ("sample-b", 8),
    ]


def test_download_model_files_skips_verified_files_without_network(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    contents = b"model weights"
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    (model_dir / "weights.bin").write_bytes(contents)
    model_lock = _fixture_model_lock(model_dir, contents)

    def no_network(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("verified files must not be downloaded again")

    monkeypatch.setattr(download_module, "urlopen", no_network)

    download_model_files(model_lock, model_dir)

    verify_file(model_dir / "weights.bin", len(contents), model_lock.files[0].sha256)


def test_download_model_files_replaces_corrupt_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    contents = b"model weights"
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    (model_dir / "weights.bin").write_bytes(b"corrupted bytes right here")
    model_lock = _fixture_model_lock(model_dir, contents)
    requested_urls: list[str] = []

    def fake_urlopen(request: object, *, timeout: int) -> BytesIO:
        requested_urls.append(request.full_url)  # type: ignore[attr-defined]
        assert timeout == 60
        return BytesIO(contents)

    monkeypatch.setattr(download_module, "urlopen", fake_urlopen)

    download_model_files(model_lock, model_dir)

    assert requested_urls == [
        "https://huggingface.co/fixture/clip/resolve/"
        f"{'a' * 40}/weights.bin?download=true"
    ]
    assert (model_dir / "weights.bin").read_bytes() == contents


def test_clip_encoder_requires_local_model_files(tmp_path: Path) -> None:
    with pytest.raises(ModelFilesMissingError, match="missing"):
        ClipEncoder(tmp_path, load_model_lock())


def test_clip_encoder_pins_the_slow_processor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    model_contents = b"model weights"
    model_lock = _fixture_model_lock(tmp_path, model_contents)
    (tmp_path / "weights.bin").write_bytes(model_contents)
    processor_loader = Mock(return_value=Mock())

    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace())
    monkeypatch.setitem(
        sys.modules,
        "transformers",
        SimpleNamespace(
            CLIPModel=SimpleNamespace(from_pretrained=Mock(return_value=Mock())),
            CLIPProcessor=SimpleNamespace(from_pretrained=processor_loader),
        ),
    )

    ClipEncoder(tmp_path, model_lock)

    processor_loader.assert_called_once_with(
        str(tmp_path), local_files_only=True, use_fast=False
    )


def test_clip_encoder_honors_the_requested_device(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    model_contents = b"model weights"
    model_lock = _fixture_model_lock(tmp_path, model_contents)
    (tmp_path / "weights.bin").write_bytes(model_contents)
    model = Mock()

    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace())
    monkeypatch.setitem(
        sys.modules,
        "transformers",
        SimpleNamespace(
            CLIPModel=SimpleNamespace(from_pretrained=Mock(return_value=model)),
            CLIPProcessor=SimpleNamespace(from_pretrained=Mock(return_value=Mock())),
        ),
    )

    ClipEncoder(tmp_path, model_lock, device="cpu")
    model.to.assert_not_called()

    ClipEncoder(tmp_path, model_lock, device="mps")
    model.to.assert_called_once_with("mps")


def test_api_text_encoder_runs_on_the_cpu(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Requests run on several threads, and PyTorch's Metal backend crashes
    under concurrent use, so the API never puts its text encoder on a GPU."""
    constructed: list[tuple[Path, object, dict[str, object]]] = []

    def fake_encoder(model_dir: Path, model_lock: object, **kwargs: object) -> object:
        constructed.append((model_dir, model_lock, kwargs))
        return Mock()

    monkeypatch.setattr(clip_encoder_module, "ClipEncoder", fake_encoder)
    settings = Settings.for_data_dir(tmp_path)

    _load_clip_text_encoder(settings)

    assert constructed == [(settings.model_dir, load_model_lock(), {"device": "cpu"})]


def test_packaged_model_lock_pins_the_expected_model() -> None:
    model_lock = load_model_lock()

    assert model_lock.repo_id == "openai/clip-vit-base-patch32"
    assert len(model_lock.revision) == 40
    assert model_lock.embedding_dimension == 512
    file_names = {model_file.path for model_file in model_lock.files}
    assert "model.safetensors" in file_names
    assert "config.json" in file_names
    assert "preprocessor_config.json" in file_names
    # Only the safetensors weight is pinned, not the other framework formats.
    assert file_names.isdisjoint(
        {"pytorch_model.bin", "tf_model.h5", "flax_model.msgpack"}
    )


def test_tracked_model_lock_matches_the_packaged_lock() -> None:
    assert load_model_lock(TRACKED_MODEL_LOCK_PATH) == load_model_lock()


@pytest.mark.parametrize(
    ("override", "match"),
    [
        ({"revision": "main"}, "commit SHA"),
        ({"embedding_dimension": 0}, "embedding dimension"),
        ({"files": []}, "at least one file"),
        (
            {"files": [{"path": "../evil", "size_bytes": 1, "sha256": "0" * 64}]},
            "Invalid path",
        ),
    ],
    ids=["branch-revision", "zero-dimension", "no-files", "unsafe-path"],
)
def test_model_lock_rejects_invalid_content(
    tmp_path: Path, override: dict[str, object], match: str
) -> None:
    lock_value = {
        "schema_version": 1,
        "repo_id": "fixture/clip",
        "revision": "a" * 40,
        "embedding_dimension": 2,
        "preprocessing_version": 1,
        "files": [{"path": "weights.bin", "size_bytes": 1, "sha256": "0" * 64}],
        **override,
    }
    lock_path = tmp_path / "clip.lock.json"
    lock_path.write_text(json.dumps(lock_value), encoding="utf-8")

    with pytest.raises(RuntimeError, match=match):
        load_model_lock(lock_path)


def test_similar_to_ranks_by_a_sample_embedding_with_the_reference_first(
    visual_settings: Settings,
) -> None:
    with _make_client(visual_settings) as client:
        response = client.get("/api/samples", params={"similar_to": "sample-c"})

    # Against c = (0.6, 0.8): c itself scores 1.0, d 0.8, a and b 0.6, so the
    # reference image leads its own results.
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 4
    assert [item["id"] for item in body["items"]] == [
        "sample-c",
        "sample-d",
        "sample-a",
        "sample-b",
    ]
    assert body["items"][0]["similarity"] == pytest.approx(1.0)
    assert body["items"][1]["similarity"] == pytest.approx(0.8)


def test_similar_to_composes_with_the_split_filter(visual_settings: Settings) -> None:
    # The leakage check: images similar to a test sample, within train only.
    with _make_client(visual_settings) as client:
        response = client.get(
            "/api/samples", params={"similar_to": "sample-d", "split": "train"}
        )

    assert response.status_code == 200
    assert [item["id"] for item in response.json()["items"]] == [
        "sample-c",
        "sample-a",
        "sample-b",
    ]
    assert response.json()["items"][0]["similarity"] == pytest.approx(0.8)


def test_similar_to_gives_ranked_detail_neighbors(visual_settings: Settings) -> None:
    with _make_client(visual_settings) as client:
        reference = client.get(
            "/api/samples/sample-c", params={"similar_to": "sample-c"}
        )
        second = client.get("/api/samples/sample-d", params={"similar_to": "sample-c"})

    # Similar-to-c order is c, d, a, b.
    assert reference.status_code == 200
    assert reference.json()["similarity"] == pytest.approx(1.0)
    assert reference.json()["previous_id"] is None
    assert reference.json()["next_id"] == "sample-d"
    assert second.json()["previous_id"] == "sample-c"
    assert second.json()["next_id"] == "sample-a"
    assert second.json()["similarity"] == pytest.approx(0.8)


def test_similar_to_rejects_an_unknown_sample_and_a_second_ordering(
    visual_settings: Settings,
) -> None:
    with _make_client(visual_settings) as client:
        unknown = client.get("/api/samples", params={"similar_to": "missing"})
        both = client.get(
            "/api/samples", params={"similar_to": "sample-c", "rank": "up"}
        )
        both_detail = client.get(
            "/api/samples/sample-c", params={"similar_to": "sample-c", "rank": "up"}
        )

    assert unknown.status_code == 404
    assert unknown.json() == {"detail": "Reference sample not found"}
    assert both.status_code == 422
    assert both_detail.status_code == 422


def test_similar_to_is_trimmed_like_a_description(visual_settings: Settings) -> None:
    with _make_client(visual_settings) as client:
        padded = client.get("/api/samples", params={"similar_to": "  sample-c  "})
        blank = client.get("/api/samples", params={"similar_to": "   "})

    assert padded.status_code == 200
    assert padded.json()["items"][0]["id"] == "sample-c"
    assert blank.status_code == 422


def test_similar_to_unavailable_without_the_visual_index(tmp_path: Path) -> None:
    settings = _prepare_visual_settings(tmp_path)
    settings.visual_manifest_path.unlink()

    with _make_client(settings) as client:
        response = client.get("/api/samples", params={"similar_to": "sample-c"})

    assert response.status_code == 503


def test_similar_to_does_not_load_the_text_encoder(visual_settings: Settings) -> None:
    factory = Mock(side_effect=AssertionError("the text encoder must not load"))

    with TestClient(
        create_app(visual_settings, text_encoder_factory=factory)
    ) as client:
        response = client.get("/api/samples", params={"similar_to": "sample-c"})

    assert response.status_code == 200
    factory.assert_not_called()
