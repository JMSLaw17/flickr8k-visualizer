import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'

import type { DatasetOverview, SampleDetail } from '../api'
import RoutedDetailPanel from '../components/RoutedDetailPanel'
import OverviewPage from './OverviewPage'

const overview: DatasetOverview = {
  sample_count: 8000,
  caption_count: 40000,
  split_counts: { train: 6000, validation: 1000, test: 1000 },
  caption_lengths: [
    { label: '9', count: 3815, min: 9, max: 10 },
    { label: '10', count: 4270, min: 10, max: 11 },
    { label: '30+', count: 35, min: 30, max: null },
  ],
  top_terms: [
    { term: 'dog', count: 8111 },
    { term: 'man', count: 7194 },
  ],
  widths: [
    { label: '450–499', count: 174, min: 450, max: 500 },
    { label: '500–549', count: 0, min: 500, max: 550 },
  ],
  heights: [{ label: '350–399', count: 2723, min: 350, max: 400 }],
  aspect_ratios: [{ label: '1.25–1.5', count: 2755, min: 1.25, max: 1.5 }],
  duplicates: {
    group_count: 2,
    affected_sample_count: 5,
    cross_split_group_count: 1,
    groups: [
      {
        content_sha256: 'a'.repeat(64),
        sample_count: 2,
        splits: ['train', 'test'],
        cross_split: true,
        samples: [
          {
            id: 'dup-1',
            source_id: 'dup-1.jpg',
            split: 'train',
            thumbnail_url: '/media/thumbnails/dup-1.webp',
          },
          {
            id: 'dup-2',
            source_id: 'dup-2.jpg',
            split: 'test',
            thumbnail_url: '/media/thumbnails/dup-2.webp',
          },
        ],
      },
      {
        content_sha256: 'b'.repeat(64),
        sample_count: 3,
        splits: ['train'],
        cross_split: false,
        samples: [
          {
            id: 'same-1',
            source_id: 'same-1.jpg',
            split: 'train',
            thumbnail_url: '/media/thumbnails/same-1.webp',
          },
        ],
      },
    ],
  },
}

const memberDetail: SampleDetail = {
  id: 'dup-1',
  source_id: 'dup-1.jpg',
  split: 'train',
  content_sha256: 'a'.repeat(64),
  width: 500,
  height: 375,
  mime_type: 'image/jpeg',
  file_size_bytes: 42_000,
  image_url: '/media/images/dup-1.jpg',
  thumbnail_url: '/media/thumbnails/dup-1.webp',
  captions: ['Two dogs on a beach.'],
  previous_id: null,
  next_id: null,
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderOverview(initialEntry = '/overview') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <OverviewPage />
      <RoutedDetailPanel />
    </MemoryRouter>,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.style.overflow = ''
})

it('links chart values to matching gallery pages', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(overview)))

  renderOverview()

  expect(
    await screen.findByText(/8,000 samples · 40,000 captions/),
  ).toBeInTheDocument()

  expect(screen.getByRole('link', { name: 'Train 6,000' })).toHaveAttribute(
    'href',
    '/?split=train',
  )
  expect(screen.getByRole('link', { name: 'dog 8,111' })).toHaveAttribute(
    'href',
    '/?term=dog',
  )
  const captionBin = screen.getByRole('link', {
    name: '9: 3,815 captions. View in gallery.',
  })
  expect(captionBin).toHaveAttribute('href', '/?min_words=9&max_words=10')
  expect(captionBin.closest('.histogram__plot')).toHaveStyle({
    '--histogram-min-width': '76px',
  })
  expect(
    screen.getByRole('link', { name: '30+: 35 captions. View in gallery.' }),
  ).toHaveAttribute('href', '/?min_words=30')
  expect(
    screen.getByRole('link', { name: '450–499: 174 samples. View in gallery.' }),
  ).toHaveAttribute('href', '/?min_width=450&max_width=500')
  expect(
    screen.getByRole('link', { name: '500–549: 0 samples. View in gallery.' }),
  ).toHaveAttribute('href', '/?min_width=500&max_width=550')
  expect(
    screen.getByRole('link', { name: '1.25–1.5: 2,755 samples. View in gallery.' }),
  ).toHaveAttribute('href', '/?min_ratio=1.25&max_ratio=1.5')
  expect(screen.getByText('Peak: 10 (4,270 captions)')).toBeInTheDocument()
})

it('summarizes duplicates and opens members in the sample drawer', async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL) =>
    Promise.resolve(
      String(input) === '/api/overview'
        ? jsonResponse(overview)
        : jsonResponse(memberDetail),
    ),
  )
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderOverview()

  expect(await screen.findByText('Duplicate groups')).toBeInTheDocument()
  expect(screen.getByText('Affected images')).toBeInTheDocument()
  expect(
    screen.getByText(/possible evaluation leakage/),
  ).toBeInTheDocument()

  const groups = screen.getAllByRole('listitem').filter((item) =>
    item.classList.contains('duplicate-group'),
  )
  expect(groups).toHaveLength(2)
  expect(groups[0]).toHaveClass('duplicate-group--cross')
  expect(groups[0]).toHaveTextContent('Cross-split')
  expect(groups[0]).toHaveTextContent('2 identical images')
  expect(groups[1]).not.toHaveClass('duplicate-group--cross')

  const memberLink = screen.getByRole('link', { name: /dup-1\.jpg/ })
  fireEvent.click(memberLink)

  expect(await screen.findByRole('dialog')).toBeInTheDocument()
  expect(
    await screen.findByRole('heading', { name: 'dup-1.jpg' }),
  ).toBeInTheDocument()
  expect(fetchMock).toHaveBeenLastCalledWith('/api/samples/dup-1', {
    signal: expect.any(AbortSignal),
  })

  await user.click(screen.getByRole('button', { name: 'Close details' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(memberLink).toHaveFocus()
})

it('returns a direct trailing-slash detail URL to the overview heading', async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL) =>
    Promise.resolve(
      String(input) === '/api/overview'
        ? jsonResponse(overview)
        : jsonResponse(memberDetail),
    ),
  )
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderOverview('/overview/?sample=dup-1')

  expect(
    await screen.findByRole('heading', { name: 'dup-1.jpg' }),
  ).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Close details' }))

  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Dataset overview' })).toHaveFocus()
  })
})

it('retries a failed overview request', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse({ detail: 'Dataset temporarily unavailable' }, 503))
    .mockResolvedValueOnce(jsonResponse(overview))
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderOverview()

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Dataset temporarily unavailable',
  )
  await user.click(screen.getByRole('button', { name: 'Try again' }))

  expect(
    await screen.findByText(/8,000 samples · 40,000 captions/),
  ).toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
