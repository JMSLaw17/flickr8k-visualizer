import { describe, expect, it } from 'vitest'

import {
  binFilters,
  filterChips,
  galleryPath,
  parseOrdering,
  withoutFilters,
  MAX_CAPTION_QUERY_LENGTH,
  normalizeCaptionQuery,
  parseOffset,
  parseRank,
  parseSampleFilters,
} from './filters'

describe('parseSampleFilters', () => {
  it('reads supported filters and drops invalid values', () => {
    const params = new URLSearchParams(
      'split=train&q=%20green+field%20&term=dog&min_words=9&max_words=abc&min_ratio=-2&max_ratio=1.5',
    )

    expect(parseSampleFilters(params)).toEqual({
      split: 'train',
      q: 'green field',
      term: 'dog',
      min_words: 9,
      max_ratio: 1.5,
    })
  })

  it('ignores unknown splits and blank text filters', () => {
    expect(parseSampleFilters(new URLSearchParams('split=dev&q=%20%20&term='))).toEqual({})
  })

  it('caps edited URL queries at the API limit', () => {
    const query = '🐕'.repeat(MAX_CAPTION_QUERY_LENGTH + 1)

    expect(parseSampleFilters(new URLSearchParams({ q: query }))).toEqual({
      q: '🐕'.repeat(MAX_CAPTION_QUERY_LENGTH),
    })
  })

  it('uses JavaScript trim semantics for caption queries', () => {
    expect(normalizeCaptionQuery('\ufeffdog\ufeff')).toBe('dog')
    expect(normalizeCaptionQuery('\u0085dog\u0085')).toBe('\u0085dog\u0085')
  })
})

describe('parseOffset', () => {
  it('accepts positive integers and rejects everything else', () => {
    expect(parseOffset(new URLSearchParams('offset=24'), 24)).toBe(24)
    expect(parseOffset(new URLSearchParams('offset=30'), 24)).toBe(24)
    expect(parseOffset(new URLSearchParams('offset=-3'), 24)).toBe(0)
    expect(parseOffset(new URLSearchParams('offset=1.5'), 24)).toBe(0)
    expect(parseOffset(new URLSearchParams(), 24)).toBe(0)
  })
})

describe('parseRank', () => {
  it('normalizes and caps rank without adding it to sample filters', () => {
    const rank = `  ${'🐕'.repeat(MAX_CAPTION_QUERY_LENGTH + 1)}  `
    const params = new URLSearchParams({ rank })

    expect(parseRank(params)).toBe('🐕'.repeat(MAX_CAPTION_QUERY_LENGTH))
    expect(parseSampleFilters(params)).toEqual({})
  })
})

describe('galleryPath', () => {
  it('encodes filters in a stable order', () => {
    expect(galleryPath({})).toBe('/')
    expect(galleryPath({ split: 'train' })).toBe('/?split=train')
    expect(galleryPath({ min_ratio: 1.25, q: 'green field', term: 'dog', max_ratio: 1.5 })).toBe(
      '/?q=green+field&term=dog&min_ratio=1.25&max_ratio=1.5',
    )
    expect(galleryPath({ split: 'test', q: 'snow' }, { rank: 'a dog' })).toBe(
      '/?split=test&q=snow&rank=a+dog',
    )
  })
})

describe('withoutFilters', () => {
  it('drops the given keys without touching the input', () => {
    const filters = { split: 'test' as const, min_words: 9, max_words: 10 }

    expect(withoutFilters(filters, ['min_words', 'max_words'])).toEqual({ split: 'test' })
    expect(filters).toEqual({ split: 'test', min_words: 9, max_words: 10 })
  })
})

describe('binFilters', () => {
  it('maps a closed bin to a half-open range', () => {
    expect(binFilters({ label: '9', count: 1, min: 9, max: 10 }, 'min_words', 'max_words'))
      .toEqual({ min_words: 9, max_words: 10 })
  })

  it('omits the upper bound for an open-ended bin', () => {
    expect(binFilters({ label: '30+', count: 1, min: 30, max: null }, 'min_words', 'max_words'))
      .toEqual({ min_words: 30 })
  })
})

describe('filterChips', () => {
  it('describes every filter with the params it clears', () => {
    const chips = filterChips({
      split: 'train',
      q: 'green field',
      term: 'dog',
      min_words: 9,
      max_words: 10,
      min_width: 450,
      max_width: 500,
      min_ratio: 1.25,
      max_ratio: 1.5,
    })

    expect(chips).toEqual([
      { label: 'Split: Train', keys: ['split'] },
      { label: 'Caption search: “green field”', keys: ['q'] },
      { label: 'Exact term: “dog”', keys: ['term'] },
      { label: 'Caption length: 9 tokens', keys: ['min_words', 'max_words'] },
      { label: 'Width: 450–499 px', keys: ['min_width', 'max_width'] },
      { label: 'Aspect ratio: 1.25–1.5', keys: ['min_ratio', 'max_ratio'] },
    ])
  })

  it('describes open-ended and upper-bounded ranges', () => {
    expect(filterChips({ min_words: 30 })).toEqual([
      { label: 'Caption length: 30+ tokens', keys: ['min_words', 'max_words'] },
    ])
    expect(filterChips({ max_height: 200 })).toEqual([
      { label: 'Height: under 200 px', keys: ['min_height', 'max_height'] },
    ])
  })

  it('describes a split on its own', () => {
    expect(filterChips({ split: 'test' })).toEqual([{ label: 'Split: Test', keys: ['split'] }])
  })
})

describe('parseOrdering', () => {
  it('reads one ordering, preferring a reference image over a description', () => {
    expect(parseOrdering(new URLSearchParams('rank=a+dog'))).toEqual({ rank: 'a dog' })
    expect(parseOrdering(new URLSearchParams('similar_to=anchor'))).toEqual({
      similar_to: 'anchor',
    })
    expect(parseOrdering(new URLSearchParams('rank=a+dog&similar_to=anchor'))).toEqual({
      similar_to: 'anchor',
    })
    expect(parseOrdering(new URLSearchParams(''))).toEqual({})
  })

  it('appends a reference-image ordering to gallery paths', () => {
    expect(galleryPath({ split: 'train' }, { similar_to: 'anchor' })).toBe(
      '/?split=train&similar_to=anchor',
    )
  })
})
