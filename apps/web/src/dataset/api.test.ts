import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  getOverview,
  getSample,
  listSamples,
  type SampleDetail,
  type SampleSummary,
} from './api'

const summary: SampleSummary = {
  id: 'sample-1',
  source_id: '123456789.jpg',
  split: 'train',
  width: 500,
  height: 375,
  thumbnail_url: '/media/thumbnails/123456789.jpg',
  caption: 'A dog runs through a field.',
  matched_captions: [],
  similarity: null,
}

const detail: SampleDetail = {
  ...summary,
  content_sha256: 'abc123',
  mime_type: 'image/jpeg',
  file_size_bytes: 42_000,
  image_url: '/media/images/123456789.jpg',
  captions: ['A dog runs through a field.'],
  previous_id: 'sample-0',
  next_id: 'sample-2',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('dataset API', () => {
  it('requests a filtered page with explicit pagination', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ total: 1, limit: 24, offset: 48, items: [summary] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await listSamples({ limit: 24, offset: 48, split: 'test' })

    expect(result.items).toEqual([summary])
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/samples?limit=24&offset=48&split=test',
      { signal: undefined },
    )
  })

  it('serializes overview filters in a stable query order', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ total: 0, limit: 24, offset: 0, items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await listSamples({
      limit: 24,
      offset: 0,
      max_ratio: 1.5,
      min_ratio: 1.25,
      q: 'green field & dog',
      term: 'dog',
      min_words: 9,
      max_words: 10,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/samples?limit=24&offset=0&q=green+field+%26+dog&term=dog&min_words=9&max_words=10&min_ratio=1.25&max_ratio=1.5',
      { signal: undefined },
    )
  })

  it('serializes visual ranking after filters on the samples endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          total: 1,
          limit: 24,
          offset: 0,
          items: [{ ...summary, similarity: 0.284 }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await listSamples({
      limit: 24,
      offset: 0,
      split: 'test',
      q: 'snow',
      term: 'dog',
      rank: 'a dog running through snow',
    })

    expect(result.items[0].similarity).toBe(0.284)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/samples?limit=24&offset=0&split=test&q=snow&term=dog&rank=a+dog+running+through+snow',
      { signal: undefined },
    )
  })

  it('requests the dataset overview', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ sample_count: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await getOverview()

    expect(fetchMock).toHaveBeenCalledWith('/api/overview', { signal: undefined })
  })

  it('scopes the overview by the gallery filters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ sample_count: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await getOverview({ min_words: 3, split: 'test' })

    expect(fetchMock).toHaveBeenCalledWith('/api/overview?split=test&min_words=3', {
      signal: undefined,
    })
  })

  it('encodes stable sample IDs and serializes detail filter context', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(detail), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await getSample('folder/image 1.jpg', {
      max_ratio: 1.5,
      min_ratio: 1.25,
      split: 'test',
      q: 'green field & dog',
      term: 'dog',
      min_words: 9,
      max_words: 10,
      min_width: 400,
      max_width: 900,
      min_height: 300,
      max_height: 700,
      rank: 'a dog jumping',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/samples/folder%2Fimage%201.jpg?split=test&q=green+field+%26+dog&term=dog&min_words=9&max_words=10&min_width=400&max_width=900&min_height=300&max_height=700&min_ratio=1.25&max_ratio=1.5&rank=a+dog+jumping',
      { signal: undefined },
    )
    expect(result.previous_id).toBe('sample-0')
    expect(result.next_id).toBe('sample-2')
  })

  it('uses the backend error detail when a request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: 'Sample not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )

    await expect(getSample('missing')).rejects.toThrow('Sample not found')
  })

  it('uses FastAPI validation messages when error detail is an array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            detail: [
              {
                type: 'string_too_long',
                loc: ['query', 'q'],
                msg: 'String should have at most 200 characters',
              },
            ],
          }),
          { status: 422, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )

    await expect(
      listSamples({ limit: 24, offset: 0, q: 'a'.repeat(201) }),
    ).rejects.toThrow('String should have at most 200 characters')
  })
})
