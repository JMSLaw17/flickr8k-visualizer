from flickr8k_visualizer.stats import (
    binned_distribution,
    summarize_duplicates,
    top_caption_terms,
)


def _bin_tuples(bins: list) -> list[tuple[str, int, float, float | None]]:
    return [(bin.label, bin.count, bin.min, bin.max) for bin in bins]


def test_unit_bins_fill_gaps_and_collapse_the_open_tail() -> None:
    bins = binned_distribution(
        {2: 1, 4: 3, 31: 2, 40: 1}, bin_width=1, open_end_start=6
    )

    assert _bin_tuples(bins) == [
        ("2", 1, 2, 3),
        ("3", 0, 3, 4),
        ("4", 3, 4, 5),
        ("5", 0, 5, 6),
        ("6+", 3, 6, None),
    ]


def test_integer_bins_use_inclusive_labels() -> None:
    bins = binned_distribution({164: 2, 210: 1, 500: 5}, bin_width=50)

    assert bins[0].label == "150–199"
    assert (bins[0].min, bins[0].max, bins[0].count) == (150, 200, 2)
    assert [bin.count for bin in bins] == [2, 1, 0, 0, 0, 0, 0, 5]
    assert bins[-1].label == "500–549"
    assert (bins[-1].min, bins[-1].max) == (500, 550)


def test_fractional_bins_label_the_half_open_range() -> None:
    bins = binned_distribution(
        {0.3: 1, 1.5: 4, 2.6: 2}, bin_width=0.25, open_end_start=2.0
    )

    assert bins[0].label == "0.25–0.5"
    assert (bins[0].min, bins[0].max, bins[0].count) == (0.25, 0.5, 1)
    assert next(bin for bin in bins if bin.label == "1.5–1.75").count == 4
    assert _bin_tuples(bins)[-1] == ("2+", 2, 2.0, None)


def test_distribution_ignores_empty_input_and_zero_counts() -> None:
    assert binned_distribution({}, bin_width=1) == []
    assert binned_distribution({7: 0}, bin_width=1) == []


def test_distribution_with_all_values_in_the_open_tail() -> None:
    bins = binned_distribution({45: 2, 60: 1}, bin_width=1, open_end_start=30)

    assert _bin_tuples(bins) == [("30+", 3, 30, None)]


def test_top_terms_filter_stopwords_and_rank_deterministically() -> None:
    captions = [
        "A brown dog runs through the water .",
        "The dog is chasing a ball",
        "Two dogs play in water",
    ]

    terms = top_caption_terms(captions, limit=4)

    assert [(term.term, term.count) for term in terms] == [
        ("dog", 2),
        ("water", 2),
        ("ball", 1),
        ("brown", 1),
    ]


def test_top_terms_drop_single_letters_and_lowercase_tokens() -> None:
    terms = top_caption_terms(["A B-boy DANCES", "b-boy dances"], limit=10)

    assert [(term.term, term.count) for term in terms] == [
        ("boy", 2),
        ("dances", 2),
    ]


def _member(
    content_sha256: str, sample_id: str, split: str = "train"
) -> dict[str, str]:
    return {
        "content_sha256": content_sha256,
        "id": sample_id,
        "source_id": f"{sample_id}.jpg",
        "split": split,
        "thumbnail_url": f"/media/thumbnails/{sample_id}.webp",
    }


def test_summarize_duplicates_counts_and_orders_cross_split_groups_first() -> None:
    summary = summarize_duplicates(
        [
            _member("b" * 64, "b2"),
            _member("b" * 64, "b1"),
            _member("b" * 64, "b3"),
            _member("a" * 64, "a2", split="test"),
            _member("a" * 64, "a1"),
        ]
    )

    assert summary.group_count == 2
    assert summary.affected_sample_count == 5
    assert summary.cross_split_group_count == 1

    cross, same = summary.groups
    assert cross.content_sha256 == "a" * 64
    assert cross.cross_split is True
    assert cross.splits == ["train", "test"]
    assert [sample.id for sample in cross.samples] == ["a1", "a2"]
    assert same.cross_split is False
    assert same.splits == ["train"]
    assert (same.sample_count, len(same.samples)) == (3, 3)


def test_summarize_duplicates_with_no_members() -> None:
    summary = summarize_duplicates([])

    assert summary.group_count == 0
    assert summary.affected_sample_count == 0
    assert summary.cross_split_group_count == 0
    assert summary.groups == []
