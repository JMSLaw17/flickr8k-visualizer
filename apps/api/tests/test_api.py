import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from flickr8k_visualizer.config import Settings
from flickr8k_visualizer.dataset_lock import load_dataset_lock
from flickr8k_visualizer.db import (
    connect_database,
    initialize_database,
    materialize_duplicate_groups,
)
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
    (image_dir / "third.jpg").write_bytes(b"original-three")
    (thumbnail_dir / "third.jpg").write_bytes(b"thumbnail-three")

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
                (
                    "sample-c",
                    "source-c",
                    "validation",
                    "c" * 64,
                    320,
                    240,
                    "image/jpeg",
                    14,
                    "images/third.jpg",
                    "thumbnails/third.jpg",
                ),
            ],
        )
        connection.executemany(
            "INSERT INTO captions (sample_id, position, text) VALUES (?, ?, ?)",
            [
                ("sample-a", 1, "The second caption."),
                ("sample-a", 0, "The first caption."),
                ("sample-a", 2, "Common 100% phrase."),
                ("sample-a", 3, "Common 100% phrase."),
                ("sample-a", 4, "Man finds needle."),
                ("sample-b", 1, "A second description."),
                ("sample-b", 0, "Another image."),
                ("sample-b", 2, "Common under_score phrase."),
                ("sample-b", 3, "Literal 100x match."),
                ("sample-b", 4, "A woman walks."),
                ("sample-c", 0, "A validation image."),
                ("sample-c", 1, "Common phrase there."),
                ("sample-c", 2, "Regex '.*_[exact]' remains."),
                ("sample-c", 3, "Quoted SQL-like text."),
                ("sample-c", 4, "Café stays accented."),
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
    assert response.json() == {"status": "ok", "visual_ranking_ready": False}


def test_lists_paginated_samples(client: TestClient) -> None:
    response = client.get("/api/samples", params={"limit": 1, "offset": 1})

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 3
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
        "matched_captions": [],
        "duplicate": False,
        "similarity": None,
    }


@pytest.mark.parametrize(
    ("split", "expected_id"),
    [
        ("validation", "sample-c"),
        ("test", "sample-b"),
    ],
)
def test_filters_remaining_supported_splits(
    client: TestClient, split: str, expected_id: str
) -> None:
    response = client.get("/api/samples", params={"split": split})

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    assert [item["id"] for item in body["items"]] == [expected_id]
    assert body["items"][0]["split"] == split


def test_gets_one_sample(client: TestClient) -> None:
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
        "captions": [
            "Another image.",
            "A second description.",
            "Common under_score phrase.",
            "Literal 100x match.",
            "A woman walks.",
        ],
        "previous_id": "sample-a",
        "next_id": "sample-c",
        "similarity": None,
    }


@pytest.mark.parametrize(
    ("sample_id", "previous_id", "next_id"),
    [
        ("sample-a", None, "sample-b"),
        ("sample-c", "sample-b", None),
    ],
    ids=["first", "last"],
)
def test_detail_navigation_has_null_ends_without_wrapping(
    client: TestClient,
    sample_id: str,
    previous_id: str | None,
    next_id: str | None,
) -> None:
    response = client.get(f"/api/samples/{sample_id}")

    assert response.status_code == 200
    assert response.json()["previous_id"] == previous_id
    assert response.json()["next_id"] == next_id


def test_detail_navigation_uses_the_complete_filtered_id_order(
    client: TestClient,
) -> None:
    response = client.get("/api/samples/sample-b", params={"term": "image"})

    assert response.status_code == 200
    assert response.json()["previous_id"] is None
    assert response.json()["next_id"] == "sample-c"


@pytest.mark.parametrize(
    ("sample_id", "params", "previous_id", "next_id"),
    [
        (
            "sample-b",
            {"min_words": 3, "max_words": 4},
            "sample-a",
            "sample-c",
        ),
        (
            "sample-a",
            {
                "min_width": 300,
                "max_width": 700,
                "min_ratio": 1.3,
                "max_ratio": 1.4,
            },
            None,
            "sample-c",
        ),
        (
            "sample-b",
            {"min_height": 400, "max_height": 700},
            "sample-a",
            None,
        ),
    ],
    ids=["caption-words", "width-and-ratio", "height"],
)
def test_detail_navigation_applies_numeric_filter_context(
    client: TestClient,
    sample_id: str,
    params: dict[str, int | float],
    previous_id: str | None,
    next_id: str | None,
) -> None:
    response = client.get(f"/api/samples/{sample_id}", params=params)

    assert response.status_code == 200
    assert response.json()["previous_id"] == previous_id
    assert response.json()["next_id"] == next_id


def test_detail_outside_filters_still_loads_without_navigation(
    client: TestClient,
) -> None:
    response = client.get("/api/samples/sample-b", params={"split": "train"})

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == "sample-b"
    assert body["captions"][0] == "Another image."
    assert body["previous_id"] is None
    assert body["next_id"] is None


def test_returns_not_found_for_missing_sample(client: TestClient) -> None:
    response = client.get("/api/samples/missing")

    assert response.status_code == 404
    assert response.json() == {"detail": "Sample not found"}


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


def test_accepts_maximum_limit_and_offset_at_end(client: TestClient) -> None:
    response = client.get("/api/samples", params={"limit": 100, "offset": 3})

    assert response.status_code == 200
    assert response.json() == {
        "total": 3,
        "limit": 100,
        "offset": 3,
        "visual_ranking_ready": False,
        "items": [],
    }


@pytest.mark.parametrize(
    "params",
    [
        {"limit": 0},
        {"limit": 101},
        {"offset": -1},
    ],
    ids=["zero-limit", "limit-above-maximum", "negative-offset"],
)
def test_rejects_invalid_pagination(client: TestClient, params: dict[str, int]) -> None:
    assert client.get("/api/samples", params=params).status_code == 422


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
        "matched_captions": "array",
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
    assert expected_summary_types.keys() <= set(summary_schema["required"])
    assert expected_detail_types.keys() <= set(detail_schema["required"])

    navigation_fields = {"previous_id", "next_id"}
    assert navigation_fields <= set(detail_schema["required"])
    for field in navigation_fields:
        variants = detail_schema["properties"][field]["anyOf"]
        assert {variant["type"] for variant in variants} == {"string", "null"}

    detail_operation = schema["paths"]["/api/samples/{sample_id}"]["get"]
    detail_query_parameters = {
        parameter["name"]
        for parameter in detail_operation["parameters"]
        if parameter["in"] == "query"
    }
    assert detail_query_parameters == {
        "split",
        "term",
        "q",
        "rank",
        "similar_to",
        "min_words",
        "max_words",
        "min_width",
        "max_width",
        "min_height",
        "max_height",
        "min_ratio",
        "max_ratio",
    }

    q_parameter = next(
        parameter
        for parameter in list_operation["parameters"]
        if parameter["name"] == "q"
    )
    q_schema = q_parameter["schema"]["anyOf"][0]
    assert q_schema["minLength"] == 1
    assert q_schema["maxLength"] == 200

    rank_parameter = next(
        parameter
        for parameter in list_operation["parameters"]
        if parameter["name"] == "rank"
    )
    rank_schema = rank_parameter["schema"]["anyOf"][0]
    assert rank_schema["minLength"] == 1
    assert rank_schema["maxLength"] == 200
    assert "/api/visual-search" not in schema["paths"]


@pytest.mark.parametrize(
    ("params", "expected_ids"),
    [
        ({"term": "image"}, ["sample-b", "sample-c"]),
        ({"term": "IMAGE"}, ["sample-b", "sample-c"]),
        ({"term": "%"}, []),
        ({"term": "_"}, []),
        ({"max_words": 3}, ["sample-b"]),
        ({"min_words": 4}, []),
        ({"min_words": 3, "max_words": 4}, ["sample-a", "sample-b", "sample-c"]),
        ({"min_width": 400, "max_width": 700}, ["sample-a"]),
        ({"min_height": 500}, ["sample-b"]),
        ({"min_ratio": 1.3, "max_ratio": 1.4}, ["sample-a", "sample-b", "sample-c"]),
        ({"max_ratio": 1.3}, []),
        ({"split": "test", "term": "image"}, ["sample-b"]),
    ],
    ids=[
        "term",
        "term-case-insensitive",
        "term-escapes-percent",
        "term-escapes-underscore",
        "max-words",
        "min-words",
        "words-range",
        "width-range",
        "min-height",
        "ratio-range",
        "max-ratio",
        "split-and-term",
    ],
)
def test_filters_samples_by_caption_and_geometry(
    client: TestClient, params: dict[str, object], expected_ids: list[str]
) -> None:
    response = client.get("/api/samples", params=params)

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == len(expected_ids)
    assert [item["id"] for item in body["items"]] == expected_ids


@pytest.mark.parametrize(
    "params",
    [
        {"term": ""},
        {"min_words": 0},
        {"min_ratio": 0},
        {"max_ratio": -1},
    ],
    ids=["empty-term", "zero-min-words", "zero-min-ratio", "negative-max-ratio"],
)
def test_rejects_invalid_filters(client: TestClient, params: dict[str, object]) -> None:
    assert client.get("/api/samples", params=params).status_code == 422


def test_caption_search_groups_every_matching_caption_and_trims_query(
    client: TestClient,
) -> None:
    response = client.get("/api/samples", params={"q": "  COMMON 100% PHRASE.  "})

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    assert [item["id"] for item in body["items"]] == ["sample-a"]
    assert body["items"][0]["matched_captions"] == [
        "Common 100% phrase.",
        "Common 100% phrase.",
    ]


def test_caption_search_includes_a_match_in_the_fifth_caption(
    client: TestClient,
) -> None:
    response = client.get("/api/samples", params={"q": "needle"})

    assert response.status_code == 200
    assert response.json()["items"][0]["matched_captions"] == ["Man finds needle."]


def test_caption_search_orders_matches_by_caption_position(client: TestClient) -> None:
    response = client.get("/api/samples", params={"q": "caption"})

    assert response.status_code == 200
    items = response.json()["items"]
    assert items[0]["id"] == "sample-a"
    assert items[0]["matched_captions"] == [
        "The first caption.",
        "The second caption.",
    ]


def test_caption_search_paginates_unique_samples(client: TestClient) -> None:
    response = client.get(
        "/api/samples", params={"q": "common", "limit": 1, "offset": 1}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 3
    assert body["limit"] == 1
    assert body["offset"] == 1
    assert [item["id"] for item in body["items"]] == ["sample-b"]
    assert body["items"][0]["matched_captions"] == ["Common under_score phrase."]


@pytest.mark.parametrize(
    ("params", "expected_ids"),
    [
        ({"q": "common", "split": "validation"}, ["sample-c"]),
        ({"q": "common", "min_width": 700}, ["sample-b"]),
        ({"q": "common", "term": "woman"}, ["sample-b"]),
        ({"q": "common", "max_words": 3}, ["sample-b"]),
    ],
    ids=["split", "geometry", "term", "caption-length"],
)
def test_caption_search_combines_with_gallery_filters(
    client: TestClient, params: dict[str, object], expected_ids: list[str]
) -> None:
    response = client.get("/api/samples", params=params)

    assert response.status_code == 200
    assert [item["id"] for item in response.json()["items"]] == expected_ids


@pytest.mark.parametrize(
    ("query", "expected_ids"),
    [
        ("MAN", ["sample-a"]),
        ("woman", ["sample-b"]),
        ("need", []),
        ("100", ["sample-a"]),
        ("FIRST CAPTION", ["sample-a"]),
        ("first  caption", []),
        ("%", ["sample-a"]),
        ("_", ["sample-b", "sample-c"]),
        (".*_[exact]", ["sample-c"]),
        ("' OR 1=1 --", []),
        ("İ", []),
        ("ı", []),
        ("ſ", []),
        ("K", []),
        ("café", ["sample-c"]),
        ("CAFÉ", []),
        ("\ufeffMAN\ufeff", ["sample-a"]),
        ("\u0085MAN\u0085", []),
    ],
    ids=[
        "case-and-leading-boundary",
        "whole-word",
        "trailing-boundary",
        "numeric-boundary",
        "phrase-and-case",
        "internal-space-is-exact",
        "sql-percent-is-literal",
        "sql-underscore-is-literal",
        "regex-metacharacters-are-literal",
        "sql-looking-input-is-literal",
        "unicode-capital-i-dot-is-literal",
        "unicode-dotless-i-is-literal",
        "unicode-long-s-is-literal",
        "unicode-kelvin-sign-is-literal",
        "non-ascii-case-is-literal-match",
        "non-ascii-case-is-not-folded",
        "ecmascript-byte-order-mark-is-trimmed",
        "next-line-control-is-not-trimmed",
    ],
)
def test_caption_search_literal_matching(
    client: TestClient, query: str, expected_ids: list[str]
) -> None:
    response = client.get("/api/samples", params={"q": query})

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == len(expected_ids)
    assert [item["id"] for item in body["items"]] == expected_ids


def test_caption_search_returns_an_empty_page(client: TestClient) -> None:
    response = client.get("/api/samples", params={"q": "not present"})

    assert response.status_code == 200
    assert response.json() == {
        "total": 0,
        "limit": 24,
        "offset": 0,
        "visual_ranking_ready": False,
        "items": [],
    }


@pytest.mark.parametrize(
    "query",
    ["", "   ", "\ufeff", "a" * 201],
    ids=["empty", "whitespace-only", "byte-order-mark-only", "too-long"],
)
def test_caption_search_rejects_invalid_queries(client: TestClient, query: str) -> None:
    assert client.get("/api/samples", params={"q": query}).status_code == 422


@pytest.fixture
def overview_client(tmp_path: Path) -> TestClient:
    data_dir = tmp_path / "data"
    database_path = data_dir / "flickr8k.sqlite3"
    _write_prepared_identity(data_dir)
    initialize_database(database_path)
    with connect_database(database_path) as connection:
        connection.executemany(
            """
            INSERT INTO samples (
                id, source_id, split, content_sha256, width, height,
                mime_type, file_size_bytes, original_path, thumbnail_path
            ) VALUES (?, ?, ?, ?, ?, ?, 'image/jpeg', 10, ?, ?)
            """,
            [
                (
                    "dup-a1",
                    "a1.jpg",
                    "train",
                    "a" * 64,
                    500,
                    375,
                    "images/a1.jpg",
                    "thumbnails/a1.webp",
                ),
                (
                    "dup-a2",
                    "a2.jpg",
                    "test",
                    "a" * 64,
                    500,
                    375,
                    "images/a2.jpg",
                    "thumbnails/a2.webp",
                ),
                (
                    "solo-b",
                    "b.jpg",
                    "train",
                    "b" * 64,
                    333,
                    500,
                    "images/b.jpg",
                    "thumbnails/b.webp",
                ),
            ],
        )
        connection.executemany(
            "INSERT INTO captions (sample_id, position, text) VALUES (?, ?, ?)",
            [
                ("dup-a1", 0, "A brown dog runs ."),
                ("dup-a1", 1, "A\tman watches a woman"),
                ("dup-a2", 0, "Dog splashing in water"),
                ("solo-b", 0, "Two dogs run"),
                ("solo-b", 1, "A  woman walks"),
            ],
        )
        materialize_duplicate_groups(connection)

    settings = Settings(
        data_dir=data_dir,
        database_path=database_path,
        manifest_path=data_dir / "manifest.json",
        cors_origins=(),
    )
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def test_lists_samples_flag_exact_duplicates(overview_client: TestClient) -> None:
    response = overview_client.get("/api/samples")

    assert response.status_code == 200
    assert [(item["id"], item["duplicate"]) for item in response.json()["items"]] == [
        ("dup-a1", True),
        ("dup-a2", True),
        ("solo-b", False),
    ]


def test_overview_reports_distributions_and_duplicates(
    overview_client: TestClient,
) -> None:
    response = overview_client.get("/api/overview")

    assert response.status_code == 200
    body = response.json()
    assert body["sample_count"] == 3
    assert body["caption_count"] == 5
    assert body["split_counts"] == {"train": 2, "validation": 0, "test": 1}
    assert body["caption_lengths"] == [
        {"label": "3", "count": 2, "min": 3, "max": 4},
        {"label": "4", "count": 1, "min": 4, "max": 5},
        {"label": "5", "count": 2, "min": 5, "max": 6},
    ]
    assert body["top_terms"][:2] == [
        {"term": "dog", "count": 2},
        {"term": "woman", "count": 2},
    ]
    assert body["dimensions"] == {
        "top": [
            {"width": 500, "height": 375, "count": 2},
            {"width": 333, "height": 500, "count": 1},
        ],
        "other_sample_count": 0,
        "other_size_count": 0,
    }
    assert body["aspect_ratios"] == [
        {"label": "0.5–0.75", "count": 1, "min": 0.5, "max": 0.75},
        {"label": "0.75–1", "count": 0, "min": 0.75, "max": 1.0},
        {"label": "1–1.25", "count": 0, "min": 1.0, "max": 1.25},
        {"label": "1.25–1.5", "count": 2, "min": 1.25, "max": 1.5},
    ]
    assert body["duplicates"] == {
        "group_count": 1,
        "affected_sample_count": 2,
        "cross_split_group_count": 1,
        "groups": [
            {
                "content_sha256": "a" * 64,
                "sample_count": 2,
                "splits": ["train", "test"],
                "cross_split": True,
                "samples": [
                    {
                        "id": "dup-a1",
                        "source_id": "a1.jpg",
                        "split": "train",
                        "thumbnail_url": "/media/thumbnails/a1.webp",
                    },
                    {
                        "id": "dup-a2",
                        "source_id": "a2.jpg",
                        "split": "test",
                        "thumbnail_url": "/media/thumbnails/a2.webp",
                    },
                ],
            }
        ],
    }


def test_overview_is_scoped_by_the_gallery_filters(
    overview_client: TestClient,
) -> None:
    response = overview_client.get("/api/overview", params={"split": "train"})

    assert response.status_code == 200
    body = response.json()
    assert body["sample_count"] == 2
    assert body["caption_count"] == 4
    # The split chart ignores the split filter so the other filters can be
    # compared across splits; every other value is scoped.
    assert body["split_counts"] == {"train": 2, "validation": 0, "test": 1}
    assert [(bin["label"], bin["count"]) for bin in body["caption_lengths"]] == [
        ("3", 2),
        ("4", 0),
        ("5", 2),
    ]
    assert body["top_terms"][:2] == [
        {"term": "woman", "count": 2},
        {"term": "brown", "count": 1},
    ]
    # Equal counts fall back to ascending width, then height.
    assert body["dimensions"]["top"] == [
        {"width": 333, "height": 500, "count": 1},
        {"width": 500, "height": 375, "count": 1},
    ]
    assert [bin["count"] for bin in body["aspect_ratios"]] == [1, 0, 0, 1]
    # Duplicates stay dataset-wide so cross-split leakage remains visible.
    assert body["duplicates"]["cross_split_group_count"] == 1
    assert [
        member["split"] for member in body["duplicates"]["groups"][0]["samples"]
    ] == ["train", "test"]


def test_overview_scopes_caption_counts_by_caption_search(
    overview_client: TestClient,
) -> None:
    response = overview_client.get("/api/overview", params={"q": "dog"})

    assert response.status_code == 200
    body = response.json()
    # Both samples with a caption containing "dog" are in scope, and every
    # caption of an in-scope sample counts, not only the matching ones.
    assert body["sample_count"] == 2
    assert body["caption_count"] == 3
    assert body["split_counts"] == {"train": 1, "validation": 0, "test": 1}
    assert body["dimensions"]["top"] == [{"width": 500, "height": 375, "count": 2}]

    narrowed = overview_client.get(
        "/api/overview", params={"q": "dog", "split": "train"}
    ).json()
    assert narrowed["sample_count"] == 1
    assert narrowed["split_counts"] == {"train": 1, "validation": 0, "test": 1}


def test_overview_with_no_matching_samples_is_empty_but_well_formed(
    overview_client: TestClient,
) -> None:
    response = overview_client.get("/api/overview", params={"q": "zzzqqq"})

    assert response.status_code == 200
    body = response.json()
    assert body["sample_count"] == 0
    assert body["caption_count"] == 0
    assert body["split_counts"] == {"train": 0, "validation": 0, "test": 0}
    assert body["caption_lengths"] == []
    assert body["top_terms"] == []
    assert body["dimensions"] == {
        "top": [],
        "other_sample_count": 0,
        "other_size_count": 0,
    }
    assert body["aspect_ratios"] == []
    # Duplicates are dataset-wide, so they are reported even for an empty scope.
    assert body["duplicates"]["group_count"] == 1


def test_overview_filters_link_back_to_matching_gallery_pages(
    overview_client: TestClient,
) -> None:
    body = overview_client.get("/api/overview").json()
    peak_ratio_bin = max(body["aspect_ratios"], key=lambda bin: bin["count"])

    response = overview_client.get(
        "/api/samples",
        params={"min_ratio": peak_ratio_bin["min"], "max_ratio": peak_ratio_bin["max"]},
    )

    assert response.status_code == 200
    assert response.json()["total"] == peak_ratio_bin["count"]


@pytest.mark.parametrize(
    ("term", "expected_ids"),
    [
        ("dog", ["dup-a1", "dup-a2"]),
        ("DOG", ["dup-a1", "dup-a2"]),
        ("dogs", ["solo-b"]),
        ("man", ["dup-a1"]),
        ("woman", ["dup-a1", "solo-b"]),
    ],
)
def test_overview_terms_link_to_exact_gallery_matches(
    overview_client: TestClient, term: str, expected_ids: list[str]
) -> None:
    response = overview_client.get("/api/samples", params={"term": term})

    assert response.status_code == 200
    assert [item["id"] for item in response.json()["items"]] == expected_ids


def test_returns_service_unavailable_without_database(tmp_path: Path) -> None:
    settings = Settings(
        data_dir=tmp_path,
        database_path=tmp_path / "missing.sqlite3",
        manifest_path=tmp_path / "manifest.json",
        cors_origins=(),
    )

    with TestClient(create_app(settings)) as client:
        response = client.get("/api/samples")
        search_response = client.get("/api/samples", params={"q": "caption"})
        detail_response = client.get("/api/samples/sample-a", params={"split": "train"})
        overview_response = client.get("/api/overview")

    assert response.status_code == 503
    assert response.json() == {
        "detail": "Dataset is not prepared. Run the ingestion command."
    }
    assert search_response.status_code == 503
    assert detail_response.status_code == 503
    assert overview_response.status_code == 503


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
