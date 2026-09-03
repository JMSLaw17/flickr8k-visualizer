# No `from __future__ import annotations` here: FastAPI needs evaluated
# annotations to expand the SampleFilters query model into query parameters.
import logging
from collections.abc import Callable
from pathlib import PurePosixPath
from threading import Lock
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
from .model_lock import load_model_lock
from .models import (
    SPLIT_ORDER,
    DatasetOverview,
    Health,
    RankedSampleFilters,
    SampleDetail,
    SampleFilters,
    SampleList,
    SampleQuery,
    SampleSummary,
)
from .stats import (
    ASPECT_RATIO_BIN_WIDTH,
    ASPECT_RATIO_OPEN_END,
    CAPTION_LENGTH_OPEN_END,
    binned_distribution,
    summarize_duplicates,
    top_caption_terms,
    top_dimensions,
)
from .visual_search import (
    TextEncoder,
    VisualIndexUnavailableError,
    load_embedding,
    rank_neighbors,
    rank_samples,
    visual_identity_matches_locks,
)

LOGGER = logging.getLogger(__name__)


def create_app(
    settings: Settings | None = None,
    *,
    text_encoder_factory: Callable[[], TextEncoder] | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    text_encoder = _LazyTextEncoder(
        text_encoder_factory or (lambda: _load_clip_text_encoder(settings))
    )

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

    @app.exception_handler(VisualIndexUnavailableError)
    async def visual_index_unavailable(
        _request: Request, _error: VisualIndexUnavailableError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=503,
            content={
                "detail": "Visual search is not prepared. "
                "Run the data preparation command."
            },
        )

    @app.get("/api/health", response_model=Health)
    def health() -> Health:
        return Health(status="ok", visual_ranking_ready=_visual_ranking_ready(settings))

    @app.get("/api/samples", response_model=SampleList)
    def samples(query: Annotated[SampleQuery, Query()]) -> SampleList:
        _require_prepared(settings)
        if query.ordered:
            _require_visual_ready(settings)
            total, records = rank_samples(
                settings.database_path,
                _query_vector(text_encoder, settings, query),
                filters=query,
                limit=query.limit,
                offset=query.offset,
            )
        else:
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
            visual_ranking_ready=_visual_ranking_ready(settings),
            items=[_to_summary(record) for record in records],
        )

    @app.get("/api/overview", response_model=DatasetOverview)
    def overview(filters: Annotated[SampleFilters, Query()]) -> DatasetOverview:
        # The same filters as /api/samples scope every chart, so overview
        # values always match the gallery page they link to.
        _require_prepared(settings)
        source = get_overview_source(settings.database_path, filters=filters)
        split_counts = source["split_counts"]
        duplicate_members = [
            {
                **member,
                "thumbnail_url": _media_url(member["thumbnail_path"], "thumbnails"),
            }
            for member in source["duplicate_members"]
        ]
        return DatasetOverview(
            sample_count=source["sample_count"],
            caption_count=sum(source["caption_token_counts"].values()),
            split_counts={split: split_counts.get(split, 0) for split in SPLIT_ORDER},
            caption_lengths=binned_distribution(
                source["caption_token_counts"],
                bin_width=1,
                open_end_start=CAPTION_LENGTH_OPEN_END,
            ),
            top_terms=top_caption_terms(source["captions"]),
            dimensions=top_dimensions(source["dimension_counts"]),
            aspect_ratios=binned_distribution(
                source["ratio_counts"],
                bin_width=ASPECT_RATIO_BIN_WIDTH,
                open_end_start=ASPECT_RATIO_OPEN_END,
            ),
            duplicates=summarize_duplicates(duplicate_members),
        )

    @app.get("/api/samples/{sample_id}", response_model=SampleDetail)
    def sample(
        sample_id: str,
        filters: Annotated[RankedSampleFilters, Query()],
    ) -> SampleDetail:
        _require_prepared(settings)
        record = get_sample(settings.database_path, sample_id, filters=filters)
        if record is None:
            raise HTTPException(status_code=404, detail="Sample not found")
        if filters.ordered:
            # An ordering context replaces stable-ID neighbors with
            # ranked-order neighbors and reports the sample's own similarity.
            _require_visual_ready(settings)
            record = {
                **record,
                **rank_neighbors(
                    settings.database_path,
                    _query_vector(text_encoder, settings, filters),
                    filters=filters,
                    sample_id=sample_id,
                ),
            }
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


def _visual_ranking_ready(settings: Settings) -> bool:
    return visual_identity_matches_locks(
        settings.visual_manifest_path, settings.visual_ready_path
    )


def _require_visual_ready(settings: Settings) -> None:
    if not _visual_ranking_ready(settings):
        raise VisualIndexUnavailableError("Visual search index is not ready")


def _query_vector(
    text_encoder: "_LazyTextEncoder",
    settings: Settings,
    filters: RankedSampleFilters,
) -> Any:
    """The vector to rank by: a sample's stored embedding or an encoded description."""
    if filters.similar_to is not None:
        vector = load_embedding(settings.database_path, filters.similar_to)
        if vector is None:
            raise HTTPException(status_code=404, detail="Reference sample not found")
        return vector
    if filters.rank is not None:
        return _encode_rank(text_encoder, filters.rank)
    raise HTTPException(status_code=422, detail="An ordering is required")


def _encode_rank(text_encoder: "_LazyTextEncoder", rank: str) -> Any:
    encoder = text_encoder.get(load_model_lock().revision)
    try:
        return encoder.encode_text(rank)
    except Exception as error:
        LOGGER.exception("Failed to encode the rank description")
        # The encoder loaded, so rerunning data preparation would not help;
        # report an inference failure rather than "not prepared".
        raise HTTPException(
            status_code=500,
            detail="Visual ranking failed while encoding the description. "
            "See the API log for details.",
        ) from error


class _LazyTextEncoder:
    """Load the text encoder once, on the first visual search request."""

    def __init__(self, factory: Callable[[], TextEncoder]) -> None:
        self._factory = factory
        self._lock = Lock()
        self._encoder: TextEncoder | None = None
        self._model_revision: str | None = None

    def get(self, model_revision: str) -> TextEncoder:
        with self._lock:
            if self._encoder is None or self._model_revision != model_revision:
                try:
                    encoder = self._factory()
                except Exception as error:
                    LOGGER.exception("Failed to load the CLIP text encoder")
                    # Missing, corrupt, or unloadable model files all mean the
                    # visual index is unusable, not an internal server error.
                    if isinstance(error, VisualIndexUnavailableError):
                        raise
                    raise VisualIndexUnavailableError(str(error)) from error
                self._encoder = encoder
                self._model_revision = model_revision
            return self._encoder


def _load_clip_text_encoder(settings: Settings) -> TextEncoder:
    # Imported here so the heavy model stack loads only for visual search.
    from .clip_encoder import ClipEncoder

    return ClipEncoder(settings.model_dir, load_model_lock())


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
        duplicate=bool(record["duplicate"]),
        similarity=record.get("similarity"),
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
        matched_positions=record["matched_positions"],
        previous_id=record["previous_id"],
        next_id=record["next_id"],
        similarity=record.get("similarity"),
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
