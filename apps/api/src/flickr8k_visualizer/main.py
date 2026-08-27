from __future__ import annotations

from pathlib import PurePosixPath
from typing import Any
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import Settings
from .dataset_lock import prepared_identity_matches_lock
from .db import DatabaseUnavailableError, get_sample, list_samples
from .models import DatasetSplit, Health, SampleDetail, SampleList, SampleSummary


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
    def samples(
        limit: int = Query(default=24, ge=1, le=100),
        offset: int = Query(default=0, ge=0),
        split: DatasetSplit | None = None,
    ) -> SampleList:
        _require_prepared(settings)
        total, records = list_samples(
            settings.database_path,
            limit=limit,
            offset=offset,
            split=split,
        )
        return SampleList(
            total=total,
            limit=limit,
            offset=offset,
            items=[_to_summary(record) for record in records],
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
