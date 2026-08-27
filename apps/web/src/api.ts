export type DatasetSplit = 'train' | 'validation' | 'test'

export interface SampleSummary {
  id: string
  source_id: string
  split: DatasetSplit
  width: number
  height: number
  thumbnail_url: string
  caption: string | null
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
}

export interface SamplePage {
  total: number
  limit: number
  offset: number
  items: SampleSummary[]
}

export interface ListSamplesParams {
  limit: number
  offset: number
  split?: DatasetSplit
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal })

  if (!response.ok) {
    let message = `Request failed (${response.status})`

    try {
      const body = (await response.json()) as { detail?: string }
      if (body.detail) message = body.detail
    } catch {
      // Keep the status-based fallback.
    }

    throw new Error(message)
  }

  return response.json() as Promise<T>
}

export function listSamples(
  { limit, offset, split }: ListSamplesParams,
  signal?: AbortSignal,
): Promise<SamplePage> {
  const query = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  })

  if (split) query.set('split', split)

  return request<SamplePage>(`/api/samples?${query}`, signal)
}

export function getSample(id: string, signal?: AbortSignal): Promise<SampleDetail> {
  return request<SampleDetail>(`/api/samples/${encodeURIComponent(id)}`, signal)
}
