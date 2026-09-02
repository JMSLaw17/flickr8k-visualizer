import { useMemo } from 'react'

import {
  FILTER_KEYS,
  filterSearchParams,
  type DatasetSplit,
  type DistributionBin,
  type SampleFilters,
} from './api'
import { formatSplit } from './formatters'

export const SPLITS: readonly DatasetSplit[] = ['train', 'validation', 'test']
export const MAX_CAPTION_QUERY_LENGTH = 200

/** Ranking description from the `rank` URL parameter; empty means ID order. */
export function parseRank(params: URLSearchParams): string {
  return normalizeCaptionQuery(params.get('rank') ?? '')
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

export function parseOffset(params: URLSearchParams): number {
  const value = Number(params.get('offset'))
  return Number.isInteger(value) && value > 0 ? value : 0
}

/** Gallery path with the given filters and optional visual ranking. */
export function galleryPath(filters: SampleFilters, rank = ''): string {
  const query = filterSearchParams(filters)
  if (rank) query.set('rank', rank)
  const encoded = query.toString()
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

  const ranges: [string, NumericFilterKey, NumericFilterKey, string, boolean][] = [
    ['Caption length', 'min_words', 'max_words', ' tokens', true],
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
