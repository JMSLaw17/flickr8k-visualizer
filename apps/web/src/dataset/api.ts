export type DatasetSplit = 'train' | 'validation' | 'test'

export interface SampleSummary {
  id: string
  source_id: string
  split: DatasetSplit
  width: number
  height: number
  thumbnail_url: string
  caption: string | null
  matched_captions: string[]
}

export interface SampleDetail {
  id: string
  source_id: string
  split: DatasetSplit
  content_sha256: string
  width: number
  height: number
  mime_type: string
  file_size_bytes: number
  image_url: string
  thumbnail_url: string
  captions: string[]
  previous_id: string | null
  next_id: string | null
}

export interface SamplePage {
  total: number
  limit: number
  offset: number
  items: SampleSummary[]
}

// Numeric ranges are half-open, matching the API: min <= value < max.
export interface SampleFilters {
  split?: DatasetSplit
  q?: string
  term?: string
  min_words?: number
  max_words?: number
  min_width?: number
  max_width?: number
  min_height?: number
  max_height?: number
  min_ratio?: number
  max_ratio?: number
}

export const FILTER_KEYS = [
  'split',
  'q',
  'term',
  'min_words',
  'max_words',
  'min_width',
  'max_width',
  'min_height',
  'max_height',
  'min_ratio',
  'max_ratio',
] as const satisfies readonly (keyof SampleFilters)[]

export function filterSearchParams(
  filters: SampleFilters,
  initial?: URLSearchParams,
): URLSearchParams {
  const query = new URLSearchParams(initial)
  for (const key of FILTER_KEYS) {
    const value = filters[key]
    if (value !== undefined) query.set(key, String(value))
  }
  return query
}

export interface ListSamplesParams extends SampleFilters {
  limit: number
  offset: number
}

export interface DistributionBin {
  label: string
  count: number
  min: number
  max: number | null
}

export interface TermCount {
  term: string
  count: number
}

export interface DuplicateMember {
  id: string
  source_id: string
  split: DatasetSplit
  thumbnail_url: string
}

export interface DuplicateGroup {
  content_sha256: string
  sample_count: number
  splits: DatasetSplit[]
  cross_split: boolean
  samples: DuplicateMember[]
}

export interface DuplicateSummary {
  group_count: number
  affected_sample_count: number
  cross_split_group_count: number
  groups: DuplicateGroup[]
}

export interface DatasetOverview {
  sample_count: number
  caption_count: number
  split_counts: Record<DatasetSplit, number>
  caption_lengths: DistributionBin[]
  top_terms: TermCount[]
  widths: DistributionBin[]
  heights: DistributionBin[]
  aspect_ratios: DistributionBin[]
  duplicates: DuplicateSummary
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal })

  if (!response.ok) {
    let message = `Request failed (${response.status})`

    try {
      const body = (await response.json()) as { detail?: unknown }
      const detail = errorDetail(body.detail)
      if (detail) message = detail
    } catch {
      // Keep the status-based fallback.
    }

    throw new Error(message)
  }

  return response.json() as Promise<T>
}

function errorDetail(detail: unknown): string | null {
  if (typeof detail === 'string') return detail
  if (!Array.isArray(detail)) return null

  const messages = detail.flatMap((issue) => {
    if (typeof issue !== 'object' || issue === null || !('msg' in issue)) return []
    return typeof issue.msg === 'string' ? [issue.msg] : []
  })
  return messages.length > 0 ? messages.join('; ') : null
}

export function listSamples(
  { limit, offset, ...filters }: ListSamplesParams,
  signal?: AbortSignal,
): Promise<SamplePage> {
  const query = filterSearchParams(
    filters,
    new URLSearchParams({ limit: String(limit), offset: String(offset) }),
  )

  return request<SamplePage>(`/api/samples?${query}`, signal)
}

export function getSample(
  id: string,
  filters: SampleFilters = {},
  signal?: AbortSignal,
): Promise<SampleDetail> {
  const query = filterSearchParams(filters)
  const suffix = query.size > 0 ? `?${query}` : ''
  return request<SampleDetail>(`/api/samples/${encodeURIComponent(id)}${suffix}`, signal)
}

export function getOverview(signal?: AbortSignal): Promise<DatasetOverview> {
  return request<DatasetOverview>('/api/overview', signal)
}
