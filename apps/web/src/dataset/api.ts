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
  /** Byte-identical to at least one other sample in the dataset. */
  duplicate: boolean
  /** CLIP cosine similarity to the rank query; null in unranked listings. */
  similarity: number | null
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
  /** Neighbors follow ranked order when a rank context is given. */
  previous_id: string | null
  next_id: string | null
  /** CLIP cosine similarity to the rank context; null without one. */
  similarity: number | null
}

export interface SamplePage {
  total: number
  limit: number
  offset: number
  /** Whether rank requests can currently be served, refreshed per listing. */
  visual_ranking_ready: boolean
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
  /** Orders results by CLIP similarity to a description; never changes which samples match. */
  rank?: string
  /** Orders results by CLIP similarity to a sample's image; that sample leads. */
  similar_to?: string
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

export interface DimensionCount {
  width: number
  height: number
  count: number
}

/** Most common exact pixel sizes, plus the long tail as one remainder. */
export interface DimensionSummary {
  top: DimensionCount[]
  other_sample_count: number
  other_size_count: number
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
  dimensions: DimensionSummary
  aspect_ratios: DistributionBin[]
  /** Always dataset-wide, independent of the filters that scope the charts. */
  duplicates: DuplicateSummary
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** The API answers 503 only while local data is not prepared yet. */
export function isNotPreparedError(reason: unknown): boolean {
  return reason instanceof ApiError && reason.status === 503
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

    throw new ApiError(message, response.status)
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
  { limit, offset, rank, similar_to, ...filters }: ListSamplesParams,
  signal?: AbortSignal,
): Promise<SamplePage> {
  const query = filterSearchParams(
    filters,
    new URLSearchParams({ limit: String(limit), offset: String(offset) }),
  )
  if (rank !== undefined) query.set('rank', rank)
  if (similar_to !== undefined) query.set('similar_to', similar_to)

  return request<SamplePage>(`/api/samples?${query}`, signal)
}

export interface SampleDetailParams extends SampleFilters {
  /** Ordering context: enables ranked-order neighbors and the sample's score. */
  rank?: string
  similar_to?: string
}

export function getSample(
  id: string,
  { rank, similar_to, ...filters }: SampleDetailParams = {},
  signal?: AbortSignal,
): Promise<SampleDetail> {
  const query = filterSearchParams(filters)
  if (rank !== undefined) query.set('rank', rank)
  if (similar_to !== undefined) query.set('similar_to', similar_to)
  const suffix = query.size > 0 ? `?${query}` : ''
  return request<SampleDetail>(`/api/samples/${encodeURIComponent(id)}${suffix}`, signal)
}

/** Dataset overview scoped by the same filters as the gallery listing. */
export function getOverview(
  filters: SampleFilters = {},
  signal?: AbortSignal,
): Promise<DatasetOverview> {
  const query = filterSearchParams(filters)
  const suffix = query.size > 0 ? `?${query}` : ''
  return request<DatasetOverview>(`/api/overview${suffix}`, signal)
}
