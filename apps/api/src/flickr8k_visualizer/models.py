from typing import Literal

from pydantic import BaseModel

DatasetSplit = Literal["train", "validation", "test"]


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


class Health(BaseModel):
    status: str
