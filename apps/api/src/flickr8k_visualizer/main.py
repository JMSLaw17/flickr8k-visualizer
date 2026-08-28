# No `from __future__ import annotations` here: FastAPI needs evaluated
# annotations to expand the SampleFilters query model into query parameters.
from pathlib import PurePosixPath
from typing import Annotated, Any
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import Settings
from .dataset_lock import prepared_identity_matches_lock
from .db import (
    DatabaseUnavailableError,
    get_overview_source,
    get_sample,
    list_samples,
)
from .models import (
    SPLIT_ORDER,
    DatasetOverview,
    Health,
    SampleDetail,
    SampleList,
    SampleQuery,
    SampleSummary,
)
from .stats import (
    ASPECT_RATIO_BIN_WIDTH,
    ASPECT_RATIO_OPEN_END,
    CAPTION_LENGTH_OPEN_END,
    DIMENSION_BIN_WIDTH,
    binned_distribution,
    summarize_duplicates,
    top_caption_terms,
)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    app = FastAPI(title="Flickr8k Visualizer API", version="0.1.0")

    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_origins),
            allow_methods=["GET"],
            allow_headers=["*"],
        )

    @app.exception_handler(DatabaseUnavailableError)
    async def database_unavailable(
        _request: Request, _error: DatabaseUnavailableError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=503,
            content={"detail": "Dataset is not prepared. Run the ingestion command."},
        )

    @app.get("/api/health", response_model=Health)
    def health() -> Health:
        return Health(status="ok")

    @app.get("/api/samples", response_model=SampleList)
    def samples(query: Annotated[SampleQuery, Query()]) -> SampleList:
        _require_prepared(settings)
        total, records = list_samples(
            settings.database_path,
            limit=query.limit,
            offset=query.offset,
            filters=query,
        )
        return SampleList(
            total=total,
            limit=query.limit,
            offset=query.offset,
            items=[_to_summary(record) for record in records],
        )

    @app.get("/api/overview", response_model=DatasetOverview)
    def overview() -> DatasetOverview:
        _require_prepared(settings)
        source = get_overview_source(settings.database_path)
        split_counts = source["split_counts"]
        duplicate_members = [
            {
                **member,
                "thumbnail_url": _media_url(member["thumbnail_path"], "thumbnails"),
            }
            for member in source["duplicate_members"]
        ]
        return DatasetOverview(
            sample_count=sum(split_counts.values()),
            caption_count=sum(source["caption_token_counts"].values()),
            split_counts={split: split_counts.get(split, 0) for split in SPLIT_ORDER},
            caption_lengths=binned_distribution(
                source["caption_token_counts"],
                bin_width=1,
                open_end_start=CAPTION_LENGTH_OPEN_END,
            ),
            top_terms=top_caption_terms(source["captions"]),
            widths=binned_distribution(
                source["width_counts"], bin_width=DIMENSION_BIN_WIDTH
            ),
            heights=binned_distribution(
                source["height_counts"], bin_width=DIMENSION_BIN_WIDTH
            ),
            aspect_ratios=binned_distribution(
                source["ratio_counts"],
                bin_width=ASPECT_RATIO_BIN_WIDTH,
                open_end_start=ASPECT_RATIO_OPEN_END,
            ),
            duplicates=summarize_duplicates(duplicate_members),
        )

    @app.get("/api/samples/{sample_id}", response_model=SampleDetail)
    def sample(sample_id: str) -> SampleDetail:
        _require_prepared(settings)
        record = get_sample(settings.database_path, sample_id)
        if record is None:
            raise HTTPException(status_code=404, detail="Sample not found")
        return _to_detail(record)

    app.mount(
        "/media/images",
        StaticFiles(directory=settings.data_dir / "images", check_dir=False),
        name="images",
    )
    app.mount(
        "/media/thumbnails",
        StaticFiles(directory=settings.data_dir / "thumbnails", check_dir=False),
        name="thumbnails",
    )
    return app


def _require_prepared(settings: Settings) -> None:
    if not (
        settings.database_path.is_file()
        and prepared_identity_matches_lock(settings.manifest_path, settings.ready_path)
    ):
        raise DatabaseUnavailableError("Dataset database is not ready")


def _to_summary(record: dict[str, Any]) -> SampleSummary:
    return SampleSummary(
        id=record["id"],
        source_id=record["source_id"],
        split=record["split"],
        width=record["width"],
        height=record["height"],
        thumbnail_url=_media_url(record["thumbnail_path"], "thumbnails"),
        caption=record["caption"],
        matched_captions=record["matched_captions"],
    )


def _to_detail(record: dict[str, Any]) -> SampleDetail:
    return SampleDetail(
        id=record["id"],
        source_id=record["source_id"],
        split=record["split"],
        content_sha256=record["content_sha256"],
        width=record["width"],
        height=record["height"],
        mime_type=record["mime_type"],
        file_size_bytes=record["file_size_bytes"],
        image_url=_media_url(record["original_path"], "images"),
        thumbnail_url=_media_url(record["thumbnail_path"], "thumbnails"),
        captions=record["captions"],
    )


def _media_url(relative_path: str, expected_directory: str) -> str:
    path = PurePosixPath(relative_path)
    if (
        path.is_absolute()
        or len(path.parts) < 2
        or path.parts[0] != expected_directory
        or ".." in path.parts
    ):
        raise ValueError(f"Invalid {expected_directory} path in dataset")

    asset_path = PurePosixPath(*path.parts[1:]).as_posix()
    return f"/media/{expected_directory}/{quote(asset_path, safe='/')}"


app = create_app()
