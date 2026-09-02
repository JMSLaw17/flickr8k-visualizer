import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'

import type { DatasetOverview, SampleDetail } from '../dataset/api'
import RoutedDetailPanel from '../detail/RoutedDetailPanel'
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
  dimensions: {
    top: [
      { width: 500, height: 333, count: 1499 },
      { width: 333, height: 500, count: 648 },
    ],
    other_sample_count: 4100,
    other_size_count: 240,
  },
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
  similarity: null,
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

  expect(await screen.findByText('8,000 samples')).toBeInTheDocument()
  expect(screen.getByText('40,000 captions')).toBeInTheDocument()
  expect(screen.getByText(/Click a chart value to open those samples/)).toBeInTheDocument()

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
  expect(screen.getByRole('link', { name: '500 × 333 1,499' })).toHaveAttribute(
    'href',
    '/?min_width=500&max_width=501&min_height=333&max_height=334',
  )
  expect(
    screen.getByText('4,100 samples use one of 240 other sizes.'),
  ).toBeInTheDocument()
  expect(
    screen.getByRole('link', { name: '1.25–1.5: 2,755 samples. View in gallery.' }),
  ).toHaveAttribute('href', '/?min_ratio=1.25&max_ratio=1.5')
  expect(screen.getByText('Peak: 10 (4,270 captions)')).toBeInTheDocument()
})

it('scopes the charts by the URL filters and carries them into chart links', async () => {
  const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(overview)))
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderOverview('/overview?split=test&q=snow&max_words=10')

  expect(await screen.findByText('8,000 samples in scope')).toBeInTheDocument()
  expect(screen.getByText('40,000 captions in scope')).toBeInTheDocument()
  expect(
    screen.getByText('Overview of 8,000 samples and 40,000 captions in scope'),
  ).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Test 1,000' })).toHaveClass('bar-list__row--active')
  expect(screen.getByRole('link', { name: 'Train 6,000' })).not.toHaveClass(
    'bar-list__row--active',
  )
  expect(
    screen.getByText(/the split and filters above do not apply here/),
  ).toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledWith('/api/overview?split=test&q=snow&max_words=10', {
    signal: expect.any(AbortSignal),
  })
  expect(screen.getByRole('combobox', { name: 'Dataset split' })).toHaveValue('test')
  expect(screen.getByRole('list', { name: 'Active filters' })).toHaveTextContent(
    'Caption search: “snow”',
  )
  expect(screen.getByRole('link', { name: 'dog 8,111' })).toHaveAttribute(
    'href',
    '/?split=test&q=snow&term=dog&max_words=10',
  )
  expect(screen.getByRole('link', { name: 'Train 6,000' })).toHaveAttribute(
    'href',
    '/?split=train&q=snow&max_words=10',
  )
  // Bins replace both bounds of their own range, so the scoped upper bound
  // never survives into an open-ended bin's link.
  expect(
    screen.getByRole('link', { name: '9: 3,815 captions. View in gallery.' }),
  ).toHaveAttribute('href', '/?split=test&q=snow&min_words=9&max_words=10')
  expect(
    screen.getByRole('link', { name: '30+: 35 captions. View in gallery.' }),
  ).toHaveAttribute('href', '/?split=test&q=snow&min_words=30')

  await user.selectOptions(screen.getByRole('combobox', { name: 'Dataset split' }), 'all')
  await waitFor(() => {
    expect(fetchMock).toHaveBeenLastCalledWith('/api/overview?q=snow&max_words=10', {
      signal: expect.any(AbortSignal),
    })
  })

  await user.click(
    screen.getByRole('button', { name: 'Remove filter: Caption search: “snow”' }),
  )
  await waitFor(() => {
    expect(fetchMock).toHaveBeenLastCalledWith('/api/overview?max_words=10', {
      signal: expect.any(AbortSignal),
    })
  })
})

it('offers a way back when no samples match the scope', async () => {
  const emptyOverview: DatasetOverview = {
    ...overview,
    sample_count: 0,
    caption_count: 0,
    split_counts: { train: 0, validation: 0, test: 0 },
    caption_lengths: [],
    top_terms: [],
    dimensions: { top: [], other_sample_count: 0, other_size_count: 0 },
    aspect_ratios: [],
  }
  const fetchMock = vi.fn((input: RequestInfo | URL) =>
    Promise.resolve(jsonResponse(String(input).includes('q=zzz') ? emptyOverview : overview)),
  )
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderOverview('/overview?split=test&q=zzz&rank=a+dog')

  expect(
    await screen.findByRole('heading', { name: 'No matching captions' }),
  ).toBeInTheDocument()
  expect(screen.getByText('No samples match the current filters.')).toBeInTheDocument()
  expect(screen.queryByText('Samples by split')).not.toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Clear all filters' }))

  expect(await screen.findByText('8,000 samples')).toBeInTheDocument()
  expect(fetchMock).toHaveBeenLastCalledWith('/api/overview', {
    signal: expect.any(AbortSignal),
  })
  expect(screen.getByRole('link', { name: 'Train 6,000' })).toHaveAttribute(
    'href',
    '/?split=train&rank=a+dog',
  )
})

it('compares other splits when the selected split has no matches', async () => {
  const emptySelectedSplit: DatasetOverview = {
    ...overview,
    sample_count: 0,
    caption_count: 0,
    split_counts: { train: 12, validation: 3, test: 0 },
    caption_lengths: [],
    top_terms: [],
    dimensions: { top: [], other_sample_count: 0, other_size_count: 0 },
    aspect_ratios: [],
  }
  const fetchMock = vi.fn((input: RequestInfo | URL) =>
    Promise.resolve(
      jsonResponse(String(input).includes('q=zzz') ? emptySelectedSplit : overview),
    ),
  )
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderOverview('/overview?split=test&q=zzz&rank=a+dog')

  await screen.findByRole('heading', { name: 'No matching captions' })
  expect(screen.getByRole('heading', { name: 'Samples by split (all splits)' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Test 0' })).toHaveClass('bar-list__row--active')
  expect(screen.getByRole('link', { name: 'Train 12' })).toHaveAttribute(
    'href',
    '/?split=train&q=zzz&rank=a+dog',
  )

  await user.click(screen.getByRole('button', { name: 'Clear search' }))

  await screen.findByText('8,000 samples in scope')
  expect(fetchMock).toHaveBeenLastCalledWith('/api/overview?split=test', {
    signal: expect.any(AbortSignal),
  })
  expect(screen.getByRole('link', { name: 'Train 6,000' })).toHaveAttribute(
    'href',
    '/?split=train&rank=a+dog',
  )
})

it('searches captions from the overview toolbar without a ranking field', async () => {
  const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(overview)))
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderOverview('/overview?rank=a+dog')

  await screen.findByText('8,000 samples')
  expect(screen.queryByLabelText('Rank by image content')).not.toBeInTheDocument()

  await user.type(screen.getByRole('searchbox', { name: 'Filter by caption' }), 'snow{Enter}')

  await waitFor(() => {
    expect(fetchMock).toHaveBeenLastCalledWith('/api/overview?q=snow', {
      signal: expect.any(AbortSignal),
    })
  })
  expect(screen.getByRole('list', { name: 'Active filters' })).toHaveTextContent(
    'Caption search: “snow”',
  )
  expect(screen.getByRole('link', { name: 'dog 8,111' })).toHaveAttribute(
    'href',
    '/?q=snow&term=dog&rank=a+dog',
  )

  const searchInput = screen.getByRole('searchbox', { name: 'Filter by caption' })
  await user.clear(searchInput)
  await user.type(searchInput, '{Enter}')

  await waitFor(() => {
    expect(fetchMock).toHaveBeenLastCalledWith('/api/overview', {
      signal: expect.any(AbortSignal),
    })
  })
  expect(screen.getByRole('link', { name: 'dog 8,111' })).toHaveAttribute(
    'href',
    '/?term=dog&rank=a+dog',
  )
})

it('summarizes duplicates and opens members in the sample drawer', async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL) =>
    Promise.resolve(
      String(input).startsWith('/api/overview')
        ? jsonResponse(overview)
        : jsonResponse(memberDetail),
    ),
  )
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  // Duplicates are dataset-wide, so a member opens outside the page's scope.
  renderOverview('/overview?q=snow')

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
  expect(memberLink).toHaveAttribute('href', '/overview?q=snow&sample=dup-1&scope=dataset')
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

  expect(await screen.findByText('8,000 samples')).toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
