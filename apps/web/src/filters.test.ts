import { describe, expect, it } from 'vitest'

import {
  binFilters,
  filterChips,
  galleryPath,
  parseOffset,
  parseSampleFilters,
} from './filters'

describe('parseSampleFilters', () => {
  it('reads supported filters and drops invalid values', () => {
    const params = new URLSearchParams(
      'split=train&term=dog&min_words=9&max_words=abc&min_ratio=-2&max_ratio=1.5',
    )

    expect(parseSampleFilters(params)).toEqual({
      split: 'train',
      term: 'dog',
      min_words: 9,
      max_ratio: 1.5,
    })
  })

  it('ignores unknown splits and empty terms', () => {
    expect(parseSampleFilters(new URLSearchParams('split=dev&term='))).toEqual({})
  })
})

describe('parseOffset', () => {
  it('accepts positive integers and rejects everything else', () => {
    expect(parseOffset(new URLSearchParams('offset=24'))).toBe(24)
    expect(parseOffset(new URLSearchParams('offset=-3'))).toBe(0)
    expect(parseOffset(new URLSearchParams('offset=1.5'))).toBe(0)
    expect(parseOffset(new URLSearchParams())).toBe(0)
  })
})

describe('galleryPath', () => {
  it('encodes filters in a stable order', () => {
    expect(galleryPath({})).toBe('/')
    expect(galleryPath({ split: 'train' })).toBe('/?split=train')
    expect(galleryPath({ min_ratio: 1.25, term: 'dog', max_ratio: 1.5 })).toBe(
      '/?term=dog&min_ratio=1.25&max_ratio=1.5',
    )
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
  it('describes every non-split filter with the params it clears', () => {
    const chips = filterChips({
      split: 'train',
      term: 'dog',
      min_words: 9,
      max_words: 10,
      min_width: 450,
      max_width: 500,
      min_ratio: 1.25,
      max_ratio: 1.5,
    })

    expect(chips).toEqual([
      { label: 'Captions contain “dog”', keys: ['term'] },
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

  it('returns nothing when only a split is active', () => {
    expect(filterChips({ split: 'test' })).toEqual([])
  })
})
