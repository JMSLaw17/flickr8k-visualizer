from typing import Literal

from pydantic import BaseModel, Field

DatasetSplit = Literal["train", "validation", "test"]

SPLIT_ORDER: tuple[DatasetSplit, ...] = ("train", "validation", "test")


class SampleSummary(BaseModel):
    id: str
    source_id: str
    split: DatasetSplit
    width: int
    height: int
    thumbnail_url: str
    caption: str | None


class SampleDetail(BaseModel):
    id: str
    source_id: str
    split: DatasetSplit
    content_sha256: str
    width: int
    height: int
    mime_type: str
    file_size_bytes: int
    image_url: str
    thumbnail_url: str
    captions: list[str]


class SampleList(BaseModel):
    total: int
    limit: int
    offset: int
    items: list[SampleSummary]


class SampleFilters(BaseModel):
    """Optional gallery filters; numeric ranges are half-open: min <= value < max."""

    split: DatasetSplit | None = None
    term: str | None = Field(default=None, min_length=1, max_length=80)
    min_words: int | None = Field(default=None, ge=1)
    max_words: int | None = Field(default=None, ge=1)
    min_width: int | None = Field(default=None, ge=1)
    max_width: int | None = Field(default=None, ge=1)
    min_height: int | None = Field(default=None, ge=1)
    max_height: int | None = Field(default=None, ge=1)
    min_ratio: float | None = Field(default=None, gt=0)
    max_ratio: float | None = Field(default=None, gt=0)


class SampleQuery(SampleFilters):
    """Full /api/samples query string: pagination plus the shared filters."""

    limit: int = Field(default=24, ge=1, le=100)
    offset: int = Field(default=0, ge=0)


class DistributionBin(BaseModel):
    label: str
    count: int
    min: int | float
    max: int | float | None = None


class TermCount(BaseModel):
    term: str
    count: int


class DuplicateMember(BaseModel):
    id: str
    source_id: str
    split: DatasetSplit
    thumbnail_url: str


class DuplicateGroup(BaseModel):
    content_sha256: str
    sample_count: int
    splits: list[DatasetSplit]
    cross_split: bool
    samples: list[DuplicateMember]


class DuplicateSummary(BaseModel):
    group_count: int
    affected_sample_count: int
    cross_split_group_count: int
    groups: list[DuplicateGroup]


class DatasetOverview(BaseModel):
    sample_count: int
    caption_count: int
    split_counts: dict[DatasetSplit, int]
    caption_lengths: list[DistributionBin]
    top_terms: list[TermCount]
    widths: list[DistributionBin]
    heights: list[DistributionBin]
    aspect_ratios: list[DistributionBin]
    duplicates: DuplicateSummary


class Health(BaseModel):
    status: str
