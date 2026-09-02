import type { SampleDetail, SampleSummary } from '../dataset/api'

export const summary: SampleSummary = {
  id: 'stable-sample-id',
  source_id: '123456789.jpg',
  split: 'train',
  width: 500,
  height: 375,
  thumbnail_url: '/media/thumbnails/123456789.jpg',
  caption: 'A dog runs through a green field.',
  matched_captions: [],
  duplicate: false,
  similarity: null,
}

export const detail: SampleDetail = {
  ...summary,
  content_sha256: '0123456789abcdef',
  mime_type: 'image/jpeg',
  file_size_bytes: 120_000,
  image_url: '/media/images/123456789.jpg',
  captions: [
    'A dog runs through a green field.',
    'A brown dog is running outside.',
    'A dog races across the grass.',
    'A playful dog runs through a meadow.',
    'An animal is sprinting outdoors.',
  ],
  previous_id: null,
  next_id: null,
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function pageResponse(
  items: SampleSummary[],
  { total = items.length, offset = 0 }: { total?: number; offset?: number } = {},
): Response {
  return jsonResponse({ total, limit: 24, offset, visual_ranking_ready: true, items })
}
