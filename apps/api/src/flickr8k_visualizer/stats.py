"""Pure aggregation logic behind the dataset overview endpoint."""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping
from math import floor
from typing import Any

from .caption_text import caption_terms
from .models import (
    SPLIT_ORDER,
    DistributionBin,
    DuplicateGroup,
    DuplicateMember,
    DuplicateSummary,
    TermCount,
)

TOP_TERM_LIMIT = 30
CAPTION_LENGTH_OPEN_END = 30
DIMENSION_BIN_WIDTH = 50
ASPECT_RATIO_BIN_WIDTH = 0.25
ASPECT_RATIO_OPEN_END = 2.0

# fmt: off
STOPWORDS = frozenset({
    "a", "an", "the", "and", "or", "but", "nor", "so", "yet", "of", "in", "on",
    "at", "to", "from", "by", "with", "without", "into", "onto", "over", "under",
    "above", "below", "up", "down", "out", "off", "near", "through", "across",
    "around", "between", "behind", "beside", "along", "past", "is", "are", "was",
    "were", "be", "been", "being", "am", "has", "have", "had", "do", "does",
    "did", "not", "no", "it", "its", "this", "that", "these", "those", "there",
    "here", "he", "she", "they", "them", "him", "his", "her", "their", "as",
    "for", "while", "during", "each", "some", "all", "both", "very",
})
# fmt: on


def binned_distribution(
    value_counts: Mapping[float, int],
    *,
    bin_width: float,
    open_end_start: float | None = None,
) -> list[DistributionBin]:
    """Histogram with contiguous half-open bins.

    Values at or above ``open_end_start`` collapse into a final open-ended bin.
    """
    counts = {value: count for value, count in value_counts.items() if count > 0}
    if not counts:
        return []

    first_index = floor(min(counts) / bin_width)
    open_index = None
    if open_end_start is not None and max(counts) >= open_end_start:
        open_index = round(open_end_start / bin_width)
        first_index = min(first_index, open_index)
        last_index = open_index
    else:
        last_index = floor(max(counts) / bin_width)

    totals = [0] * (last_index - first_index + 1)
    for value, count in counts.items():
        totals[min(floor(value / bin_width), last_index) - first_index] += count

    bins = []
    for offset, count in enumerate(totals):
        low = _edge(first_index + offset, bin_width)
        if first_index + offset == open_index:
            bins.append(
                DistributionBin(label=f"{low:g}+", count=count, min=low, max=None)
            )
        else:
            high = _edge(first_index + offset + 1, bin_width)
            label = _bin_label(low, high, bin_width)
            bins.append(DistributionBin(label=label, count=count, min=low, max=high))
    return bins


def _edge(index: int, bin_width: float) -> int | float:
    if isinstance(bin_width, int):
        return index * bin_width
    return round(index * bin_width, 10)


def _bin_label(low: int | float, high: int | float, bin_width: float) -> str:
    if isinstance(bin_width, int):
        return str(low) if bin_width == 1 else f"{low}–{high - 1}"
    return f"{low:g}–{high:g}"


def top_caption_terms(
    captions: Iterable[str], *, limit: int = TOP_TERM_LIMIT
) -> list[TermCount]:
    """Most frequent caption words, without short and function words."""
    counts: Counter[str] = Counter()
    for caption in captions:
        counts.update(
            token
            for token in caption_terms(caption)
            if len(token) > 1 and token not in STOPWORDS
        )
    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    return [TermCount(term=term, count=count) for term, count in ranked[:limit]]


def summarize_duplicates(members: Iterable[Mapping[str, Any]]) -> DuplicateSummary:
    """Group exact-duplicate members by content hash; cross-split groups first."""
    members_by_hash: defaultdict[str, list[DuplicateMember]] = defaultdict(list)
    for member in members:
        members_by_hash[member["content_sha256"]].append(
            DuplicateMember(
                id=member["id"],
                source_id=member["source_id"],
                split=member["split"],
                thumbnail_url=member["thumbnail_url"],
            )
        )

    groups = []
    for content_sha256, samples in members_by_hash.items():
        samples.sort(key=lambda sample: sample.id)
        splits = {sample.split for sample in samples}
        groups.append(
            DuplicateGroup(
                content_sha256=content_sha256,
                sample_count=len(samples),
                splits=sorted(splits, key=SPLIT_ORDER.index),
                cross_split=len(splits) > 1,
                samples=samples,
            )
        )
    groups.sort(
        key=lambda group: (
            -group.cross_split,
            -group.sample_count,
            group.content_sha256,
        )
    )

    return DuplicateSummary(
        group_count=len(groups),
        affected_sample_count=sum(group.sample_count for group in groups),
        cross_split_group_count=sum(1 for group in groups if group.cross_split),
        groups=groups,
    )
