import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from flickr8k_visualizer.config import Settings
from flickr8k_visualizer.dataset_lock import load_dataset_lock
from flickr8k_visualizer.db import connect_database, initialize_database
from flickr8k_visualizer.main import create_app


def _write_prepared_identity(data_dir: Path, *, ready: bool = True) -> None:
    dataset_lock = load_dataset_lock()
    manifest = {
        "dataset": {
            "repo_id": dataset_lock.repo_id,
            "revision": dataset_lock.revision,
        },
        "shards": [
            {
                "path": shard.repo_path,
                "split": shard.split,
                "size_bytes": shard.size_bytes,
                "sha256": shard.sha256,
                "row_count": shard.row_count,
            }
            for shard in dataset_lock.shards
        ],
    }
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    if ready:
        (data_dir / ".ready").write_text(f"{dataset_lock.revision}\n", encoding="utf-8")


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    data_dir = tmp_path / "data"
    database_path = data_dir / "flickr8k.sqlite3"
    image_dir = data_dir / "images"
    thumbnail_dir = data_dir / "thumbnails"
    image_dir.mkdir(parents=True)
    thumbnail_dir.mkdir()
    _write_prepared_identity(data_dir)
    (image_dir / "first image.jpg").write_bytes(b"original-one")
    (thumbnail_dir / "first image.jpg").write_bytes(b"thumbnail-one")
    (image_dir / "second.jpg").write_bytes(b"original-two")
    (thumbnail_dir / "second.jpg").write_bytes(b"thumbnail-two")

    initialize_database(database_path)
    with connect_database(database_path) as connection:
        connection.executemany(
            """
            INSERT INTO samples (
                id, source_id, split, content_sha256, width, height,
                mime_type, file_size_bytes, original_path, thumbnail_path
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    "sample-a",
                    "source-a",
                    "train",
                    "a" * 64,
                    640,
                    480,
                    "image/jpeg",
                    12,
                    "images/first image.jpg",
                    "thumbnails/first image.jpg",
                ),
                (
                    "sample-b",
                    "source-b",
                    "test",
                    "b" * 64,
                    800,
                    600,
                    "image/jpeg",
                    12,
                    "images/second.jpg",
                    "thumbnails/second.jpg",
                ),
            ],
        )
        connection.executemany(
            "INSERT INTO captions (sample_id, position, text) VALUES (?, ?, ?)",
            [
                ("sample-a", 1, "The second caption."),
                ("sample-a", 0, "The first caption."),
                ("sample-b", 0, "Another image."),
            ],
        )

    settings = Settings(
        data_dir=data_dir,
        database_path=database_path,
        manifest_path=data_dir / "manifest.json",
        cors_origins=(),
    )
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def test_health(client: TestClient) -> None:
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_lists_paginated_samples(client: TestClient) -> None:
    response = client.get("/api/samples", params={"limit": 1, "offset": 1})

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 2
    assert body["limit"] == 1
    assert body["offset"] == 1
    assert [item["id"] for item in body["items"]] == ["sample-b"]


def test_filters_samples_and_orders_captions(client: TestClient) -> None:
    response = client.get("/api/samples", params={"split": "train"})

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    assert body["items"][0] == {
        "id": "sample-a",
        "source_id": "source-a",
        "split": "train",
        "width": 640,
        "height": 480,
        "thumbnail_url": "/media/thumbnails/first%20image.jpg",
        "caption": "The first caption.",
    }


def test_gets_one_sample_and_returns_not_found(client: TestClient) -> None:
    response = client.get("/api/samples/sample-b")

    assert response.status_code == 200
    assert response.json() == {
        "id": "sample-b",
        "source_id": "source-b",
        "split": "test",
        "content_sha256": "b" * 64,
        "width": 800,
        "height": 600,
        "mime_type": "image/jpeg",
        "file_size_bytes": 12,
        "image_url": "/media/images/second.jpg",
        "thumbnail_url": "/media/thumbnails/second.jpg",
        "captions": ["Another image."],
    }
    assert client.get("/api/samples/missing").status_code == 404


@pytest.mark.parametrize(
    ("path", "content"),
    [
        ("/media/images/first%20image.jpg", b"original-one"),
        ("/media/thumbnails/first%20image.jpg", b"thumbnail-one"),
    ],
)
def test_serves_local_media(client: TestClient, path: str, content: bytes) -> None:
    response = client.get(path)

    assert response.status_code == 200
    assert response.content == content


def test_validates_pagination(client: TestClient) -> None:
    assert client.get("/api/samples", params={"limit": 0}).status_code == 422
    assert client.get("/api/samples", params={"offset": -1}).status_code == 422


def test_rejects_unknown_split(client: TestClient) -> None:
    response = client.get("/api/samples", params={"split": "development"})

    assert response.status_code == 422


def test_openapi_describes_split_and_non_nullable_sample_metadata(
    client: TestClient,
) -> None:
    schema = client.get("/openapi.json").json()
    list_operation = schema["paths"]["/api/samples"]["get"]
    split_parameter = next(
        parameter
        for parameter in list_operation["parameters"]
        if parameter["name"] == "split"
    )
    split_schema = split_parameter["schema"]["anyOf"][0]

    assert split_schema["enum"] == ["train", "validation", "test"]

    summary_schema = schema["components"]["schemas"]["SampleSummary"]
    detail_schema = schema["components"]["schemas"]["SampleDetail"]
    expected_summary_types = {
        "split": "string",
        "width": "integer",
        "height": "integer",
    }
    expected_detail_types = {
        "split": "string",
        "content_sha256": "string",
        "width": "integer",
        "height": "integer",
        "mime_type": "string",
        "file_size_bytes": "integer",
    }

    for field, expected_type in expected_summary_types.items():
        assert summary_schema["properties"][field]["type"] == expected_type
    for field, expected_type in expected_detail_types.items():
        assert detail_schema["properties"][field]["type"] == expected_type


def test_returns_service_unavailable_without_database(tmp_path: Path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        database_path=tmp_path / "missing.sqlite3",
        manifest_path=tmp_path / "manifest.json",
        cors_origins=(),
    )

    with TestClient(create_app(settings)) as client:
        response = client.get("/api/samples")

    assert response.status_code == 503
    assert response.json() == {
        "detail": "Dataset is not prepared. Run the ingestion command."
    }


def test_returns_service_unavailable_without_ready_marker(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    database_path = data_dir / "flickr8k.sqlite3"
    initialize_database(database_path)
    _write_prepared_identity(data_dir, ready=False)
    settings = Settings(
        data_dir=data_dir,
        database_path=database_path,
        manifest_path=data_dir / "manifest.json",
        cors_origins=(),
    )

    with TestClient(create_app(settings)) as client:
        response = client.get("/api/samples")

    assert response.status_code == 503


def test_returns_service_unavailable_with_stale_ready_marker(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    database_path = data_dir / "flickr8k.sqlite3"
    initialize_database(database_path)
    _write_prepared_identity(data_dir)
    (data_dir / ".ready").write_text(f"{'0' * 40}\n", encoding="utf-8")
    settings = Settings(
        data_dir=data_dir,
        database_path=database_path,
        manifest_path=data_dir / "manifest.json",
        cors_origins=(),
    )

    with TestClient(create_app(settings)) as client:
        response = client.get("/api/samples")

    assert response.status_code == 503


def test_returns_service_unavailable_with_stale_manifest(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    database_path = data_dir / "flickr8k.sqlite3"
    initialize_database(database_path)
    _write_prepared_identity(data_dir)
    manifest_path = data_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["shards"][0]["sha256"] = "0" * 64
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    settings = Settings(
        data_dir=data_dir,
        database_path=database_path,
        manifest_path=manifest_path,
        cors_origins=(),
    )

    with TestClient(create_app(settings)) as client:
        response = client.get("/api/samples")

    assert response.status_code == 503
