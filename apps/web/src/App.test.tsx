import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

import App from './App'
import type { SampleDetail, SampleSummary } from './api'

const summary: SampleSummary = {
  id: 'stable-sample-id',
  source_id: '123456789.jpg',
  split: 'train',
  width: 500,
  height: 375,
  thumbnail_url: '/media/thumbnails/123456789.jpg',
  caption: 'A dog runs through a green field.',
}

const detail: SampleDetail = {
  ...summary,
  content_sha256: '0123456789abcdef',
  mime_type: 'image/jpeg',
  file_size_bytes: 120_000,
  image_url: '/media/images/123456789.jpg',
  captions: [
    'A dog runs through a green field.',
    'A brown dog is running outside.',
  ],
}

afterEach(() => {
  vi.unstubAllGlobals()
})

it('browses samples and opens a locally loaded detail view', async () => {
  let resolveDetail!: (response: Response) => void
  const detailResponse = new Promise<Response>((resolve) => {
    resolveDetail = resolve
  })
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ total: 1, limit: 24, offset: 0, items: [summary] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    .mockReturnValueOnce(detailResponse)
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  render(<App />)

  const sampleCard = await screen.findByRole('button', {
    name: /a dog runs through a green field/i,
  })
  expect(screen.getByText(/showing 1–1 of 1/i)).toBeInTheDocument()

  await user.click(sampleCard)

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('Loading sample…')

  resolveDetail(
    new Response(JSON.stringify(detail), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )

  expect(await screen.findByRole('dialog')).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: '123456789.jpg' })).toBeInTheDocument()
  expect(screen.getByText('A brown dog is running outside.')).toBeInTheDocument()
  expect(screen.getByRole('list').tagName).toBe('UL')
  expect(screen.getByText('500 × 375 px')).toBeInTheDocument()
  expect(screen.getByText(detail.content_sha256)).toBeInTheDocument()
  expect(screen.getByText('image/jpeg · 117.2 KB')).toBeInTheDocument()
  const originalImage = screen.getByRole('img', { name: detail.captions[0] })
  expect(originalImage).toHaveAttribute('width', '500')
  expect(originalImage).toHaveAttribute('height', '375')
  expect(originalImage).toHaveStyle({ width: '500px', height: '375px' })
  expect(fetchMock).toHaveBeenLastCalledWith('/api/samples/stable-sample-id', {
    signal: expect.any(AbortSignal),
  })
})

it('refetches from the first page when the split changes', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ total: 0, limit: 24, offset: 0, items: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  render(<App />)
  await screen.findByText('No samples found')

  await user.selectOptions(screen.getByLabelText('Dataset split'), 'validation')

  await waitFor(() => {
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/samples?limit=24&offset=0&split=validation',
      { signal: expect.any(AbortSignal) },
    )
  })
})
