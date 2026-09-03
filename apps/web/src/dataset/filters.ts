import { useMemo } from 'react'

import {
  FILTER_KEYS,
  filterSearchParams,
  type DatasetSplit,
  type DistributionBin,
  type Ordering,
  type SampleFilters,
} from './api'
import { formatSplit } from './formatters'

export const SPLITS: readonly DatasetSplit[] = ['train', 'validation', 'test']
export const MAX_CAPTION_QUERY_LENGTH = 200

/** The ordering in the URL; a reference image wins over a description. */
export function parseOrdering(params: URLSearchParams): Ordering {
  const similarTo = (params.get('similar_to') ?? '').trim()
  if (similarTo) return { similar_to: similarTo }
  const rank = normalizeCaptionQuery(params.get('rank') ?? '')
  return rank ? { rank } : {}
}

/** What the ordering compares against, for summaries; empty for ID order. */
export function describeOrdering(ordering: Ordering): string {
  if (ordering.similar_to) return `similarity to image ${ordering.similar_to}`
  if (ordering.rank) return `similarity to “${ordering.rank}”`
  return ''
}

/** Removable chip for the active ordering, if any. */
export function orderingChips(ordering: Ordering): FilterChip[] {
  if (ordering.similar_to) {
    return [{ label: `Similar to: ${ordering.similar_to}`, keys: ['similar_to'] }]
  }
  if (ordering.rank) return [{ label: `Ranked by: “${ordering.rank}”`, keys: ['rank'] }]
  return []
}

type NumericFilterKey = Exclude<keyof SampleFilters, 'split' | 'q' | 'term'>

export function parseSampleFilters(params: URLSearchParams): SampleFilters {
  const filters: SampleFilters = {}

  const split = params.get('split')
  if (split && (SPLITS as readonly string[]).includes(split)) {
    filters.split = split as DatasetSplit
  }

  const term = params.get('term')
  if (term) filters.term = term

  const query = normalizeCaptionQuery(params.get('q') ?? '')
  if (query) filters.q = query

  for (const key of FILTER_KEYS) {
    if (key === 'split' || key === 'q' || key === 'term') continue
    const value = Number(params.get(key))
    if (Number.isFinite(value) && value > 0) filters[key] = value
  }

  return filters
}

export function sampleFiltersKey(params: URLSearchParams): string {
  return filterSearchParams(parseSampleFilters(params)).toString()
}

export function useSampleFilters(params: URLSearchParams): SampleFilters {
  const filtersKey = sampleFiltersKey(params)
  return useMemo(
    () => parseSampleFilters(new URLSearchParams(filtersKey)),
    [filtersKey],
  )
}

export function normalizeCaptionQuery(query: string): string {
  return [...query.trim()].slice(0, MAX_CAPTION_QUERY_LENGTH).join('')
}

/** Page offset from the URL, snapped down to a page boundary. */
export function parseOffset(params: URLSearchParams, pageSize: number): number {
  const value = Number(params.get('offset'))
  if (!Number.isInteger(value) || value <= 0) return 0
  return Math.floor(value / pageSize) * pageSize
}

/** Gallery path with the given filters and optional ordering. */
export function galleryPath(filters: SampleFilters, ordering: Ordering = {}): string {
  const encoded = filterSearchParams({ ...filters, ...ordering }).toString()
  return encoded ? `/?${encoded}` : '/'
}

/** Copy of the filters without the given keys, so a chart can replace its own range. */
export function withoutFilters(
  filters: SampleFilters,
  keys: readonly (keyof SampleFilters)[],
): SampleFilters {
  const rest = { ...filters }
  for (const key of keys) delete rest[key]
  return rest
}

/** Filters selecting one histogram bin; open-ended bins omit the upper bound. */
export function binFilters(
  bin: DistributionBin,
  minKey: NumericFilterKey,
  maxKey: NumericFilterKey,
): SampleFilters {
  const filters: SampleFilters = {}
  filters[minKey] = bin.min
  if (bin.max !== null) filters[maxKey] = bin.max
  return filters
}

export interface FilterChip {
  label: string
  keys: string[]
}

/** Removable chips describing every filter in effect. */
export function filterChips(filters: SampleFilters): FilterChip[] {
  const chips: FilterChip[] = []

  if (filters.split) {
    chips.push({ label: `Split: ${formatSplit(filters.split)}`, keys: ['split'] })
  }

  if (filters.q) {
    chips.push({ label: `Caption search: “${filters.q}”`, keys: ['q'] })
  }

  if (filters.term) {
    chips.push({ label: `Exact term: “${filters.term}”`, keys: ['term'] })
  }

  const lengthLabel = captionLengthLabel(filters.min_words, filters.max_words)
  if (lengthLabel) chips.push({ label: lengthLabel, keys: ['min_words', 'max_words'] })

  const ranges: [string, NumericFilterKey, NumericFilterKey, string, boolean][] = [
    ['Width', 'min_width', 'max_width', ' px', true],
    ['Height', 'min_height', 'max_height', ' px', true],
    ['Aspect ratio', 'min_ratio', 'max_ratio', '', false],
  ]
  for (const [name, minKey, maxKey, unit, integer] of ranges) {
    const range = describeRange(filters[minKey], filters[maxKey], integer)
    if (range) chips.push({ label: `${name}: ${range}${unit}`, keys: [minKey, maxKey] })
  }

  return chips
}

/** The length filter is per photo: any one of its captions in range qualifies. */
function captionLengthLabel(min: number | undefined, max: number | undefined): string | null {
  if (min === undefined && max === undefined) return null
  if (min === undefined) return `Has a caption under ${max} tokens`
  if (max === undefined) return `Has a caption of ${min}+ tokens`
  const last = max - 1
  if (last === min) return `Has a caption of ${min} ${min === 1 ? 'token' : 'tokens'}`
  return `Has a caption of ${min}–${last} tokens`
}

function describeRange(
  min: number | undefined,
  max: number | undefined,
  integer: boolean,
): string | null {
  if (min === undefined && max === undefined) return null
  if (min === undefined) return `under ${max}`
  if (max === undefined) return `${min}+`
  // Numeric filters are half-open ranges; show integer ones inclusively.
  if (integer) return max - min === 1 ? `${min}` : `${min}–${max - 1}`
  return `${min}–${max}`
}
