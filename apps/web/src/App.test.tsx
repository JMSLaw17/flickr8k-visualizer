import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode, useState } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'

import App from './App'
import type { SampleDetail, SampleSummary } from './api'
import DetailPanel from './components/DetailPanel'

function renderApp(initialEntry = '/') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <App />
    </MemoryRouter>,
  )
}

const summary: SampleSummary = {
  id: 'stable-sample-id',
  source_id: '123456789.jpg',
  split: 'train',
  width: 500,
  height: 375,
  thumbnail_url: '/media/thumbnails/123456789.jpg',
  caption: 'A dog runs through a green field.',
  matched_captions: [],
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
    'A dog races across the grass.',
    'A playful dog runs through a meadow.',
    'An animal is sprinting outdoors.',
  ],
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function pageResponse(
  items: SampleSummary[],
  { total = items.length, offset = 0 }: { total?: number; offset?: number } = {},
): Response {
  return jsonResponse({ total, limit: 24, offset, items })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.style.overflow = ''
  document.title = 'Flickr8k Explorer'
})

function StrictModeDetailHarness() {
  const [isOpen, setIsOpen] = useState(true)

  return isOpen ? (
    <DetailPanel sampleId={detail.id} onClose={() => setIsOpen(false)} />
  ) : null
}

it('shows every caption and the original at its exact dimensions', async () => {
  let resolveDetail!: (response: Response) => void
  const detailResponse = new Promise<Response>((resolve) => {
    resolveDetail = resolve
  })
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(pageResponse([summary]))
    .mockReturnValueOnce(detailResponse)
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp()

  const sampleCard = await screen.findByRole('button', {
    name: /a dog runs through a green field/i,
  })
  expect(
    screen.getByText(/showing 1–1 of 1/i, { selector: '.results-summary' }),
  ).toBeInTheDocument()

  await user.click(sampleCard)

  const loadingDialog = screen.getByRole('dialog')
  const detailPanel = loadingDialog.querySelector('.detail-panel')
  const closeButton = screen.getByRole('button', { name: 'Close details' })
  expect(loadingDialog.tagName).toBe('DIALOG')
  expect(loadingDialog).toHaveAttribute('open')
  expect(detailPanel).toHaveClass('detail-panel--loading')
  expect(loadingDialog).toHaveAccessibleName('Sample details')
  expect(closeButton).toHaveFocus()
  expect(screen.getByRole('status')).toHaveTextContent('Loading sample…')
  expect(document.body.style.overflow).toBe('hidden')

  resolveDetail(jsonResponse(detail))

  expect(
    await screen.findByRole('heading', { name: '123456789.jpg' }),
  ).toBeInTheDocument()
  expect(screen.getByRole('dialog')).toBe(loadingDialog)
  expect(detailPanel).not.toHaveClass('detail-panel--loading')
  expect(screen.getByRole('dialog')).toHaveAccessibleName('123456789.jpg')
  expect(screen.getByRole('button', { name: 'Close details' })).toBe(closeButton)
  expect(closeButton).toHaveFocus()
  expect(screen.getByRole('list').tagName).toBe('UL')
  const captionItems = screen.getAllByRole('listitem')
  expect(captionItems.map((item) => item.textContent)).toEqual(detail.captions)
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

  expect(
    fireEvent(loadingDialog, new Event('cancel', { cancelable: true })),
  ).toBe(false)

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(document.body.style.overflow).toBe('')
})

it('closes and aborts a deferred detail request', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(pageResponse([summary]))
    .mockReturnValueOnce(new Promise<Response>(() => undefined))
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp()

  const sampleCard = await screen.findByRole('button', {
    name: /a dog runs through a green field/i,
  })
  await user.click(sampleCard)

  const detailRequest = fetchMock.mock.calls[1]?.[1] as { signal: AbortSignal }
  const dialog = screen.getByRole('dialog')
  const closeButton = screen.getByRole('button', { name: 'Close details' })
  expect(dialog.querySelector('.detail-panel')).toHaveClass('detail-panel--loading')
  expect(closeButton).toHaveFocus()
  expect(detailRequest.signal.aborted).toBe(false)

  await user.click(closeButton)

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(detailRequest.signal.aborted).toBe(true)
})

it('balances the native dialog lifecycle under Strict Mode', async () => {
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(detail)))
  vi.stubGlobal('fetch', fetchMock)
  const showModalSpy = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
  const closeSpy = vi.spyOn(HTMLDialogElement.prototype, 'close')
  const user = userEvent.setup()

  render(
    <StrictMode>
      <StrictModeDetailHarness />
    </StrictMode>,
  )

  expect(
    await screen.findByRole('heading', { name: detail.source_id }),
  ).toBeInTheDocument()
  expect(screen.getByRole('dialog')).toHaveAttribute('open')
  expect(showModalSpy).toHaveBeenCalledTimes(2)
  expect(closeSpy).toHaveBeenCalledTimes(1)
  expect(fetchMock).toHaveBeenCalledTimes(2)

  const requestSignals = fetchMock.mock.calls.map(
    ([, options]) => (options as { signal: AbortSignal }).signal,
  )
  expect(requestSignals[0].aborted).toBe(true)
  expect(requestSignals[1].aborted).toBe(false)

  await user.click(screen.getByRole('button', { name: 'Close details' }))

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(closeSpy).toHaveBeenCalledTimes(2)
  expect(requestSignals[1].aborted).toBe(true)
  expect(document.body.style.overflow).toBe('')
})

it('retries detail errors and handles a failed original image', async () => {
  let resolveRetry!: (response: Response) => void
  const retryResponse = new Promise<Response>((resolve) => {
    resolveRetry = resolve
  })
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(pageResponse([summary]))
    .mockResolvedValueOnce(jsonResponse({ detail: 'Detail temporarily unavailable' }, 503))
    .mockReturnValueOnce(retryResponse)
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp()
  await user.click(
    await screen.findByRole('button', { name: /a dog runs through a green field/i }),
  )

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Couldn’t load this sampleDetail temporarily unavailable',
  )

  const closeButton = screen.getByRole('button', { name: 'Close details' })
  const retryButton = screen.getByRole('button', { name: 'Try again' })
  expect(closeButton).toHaveFocus()
  await user.click(retryButton)
  expect(await screen.findByRole('status')).toHaveTextContent('Loading sample…')
  expect(screen.getByRole('dialog').querySelector('.detail-panel')).toHaveClass(
    'detail-panel--loading',
  )
  expect(screen.getByRole('button', { name: 'Close details' })).toBe(closeButton)
  expect(closeButton).toHaveFocus()

  resolveRetry(jsonResponse(detail))
  expect(
    await screen.findByRole('heading', { name: '123456789.jpg' }),
  ).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Close details' })).toBe(closeButton)
  expect(closeButton).toHaveFocus()

  fireEvent.error(screen.getByRole('img', { name: detail.captions[0] }))

  const fallback = screen.getByRole('img', { name: detail.captions[0] })
  expect(fallback).toHaveTextContent('Image unavailable')
  expect(fallback).toHaveStyle({ width: '500px', height: '375px' })
})

it('paginates, resets a changed filter, and preserves gallery state after detail', async () => {
  const secondPageSummary: SampleSummary = {
    ...summary,
    id: 'second-page-sample',
    source_id: '987654321.jpg',
    split: 'validation',
    caption: 'A sample on the second page.',
    matched_captions: [],
  }
  const secondPageDetail: SampleDetail = {
    ...detail,
    ...secondPageSummary,
    image_url: '/media/images/987654321.jpg',
    captions: ['A sample on the second page.'],
  }
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(pageResponse([summary], { total: 25 }))
    .mockResolvedValueOnce(pageResponse([secondPageSummary], { total: 25, offset: 24 }))
    .mockResolvedValueOnce(pageResponse([summary], { total: 25 }))
    .mockResolvedValueOnce(pageResponse([secondPageSummary], { total: 25, offset: 24 }))
    .mockResolvedValueOnce(jsonResponse(secondPageDetail))
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp()

  await screen.findByRole('button', { name: /a dog runs through a green field/i })
  expect(screen.getByRole('button', { name: /← previous/i })).toBeDisabled()

  await user.click(screen.getByRole('button', { name: /next →/i }))
  const unfilteredSecondPageCard = await screen.findByRole('button', {
    name: /a sample on the second page/i,
  })
  expect(unfilteredSecondPageCard).toBeInTheDocument()
  expect(fetchMock).toHaveBeenLastCalledWith('/api/samples?limit=24&offset=24', {
    signal: expect.any(AbortSignal),
  })

  await user.selectOptions(screen.getByLabelText('Dataset split'), 'validation')

  await waitFor(() => {
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/samples?limit=24&offset=0&split=validation',
      { signal: expect.any(AbortSignal) },
    )
  })

  await screen.findByRole('button', { name: /a dog runs through a green field/i })
  expect(screen.getByRole('button', { name: /← previous/i })).toBeDisabled()

  await user.click(screen.getByRole('button', { name: /next →/i }))
  const filteredSecondPageCard = await screen.findByRole('button', {
    name: /a sample on the second page/i,
  })
  expect(fetchMock).toHaveBeenLastCalledWith(
    '/api/samples?limit=24&offset=24&split=validation',
    { signal: expect.any(AbortSignal) },
  )

  await user.click(filteredSecondPageCard)
  const dialog = await screen.findByRole('dialog')
  await screen.findByRole('heading', { name: '987654321.jpg' })
  fireEvent.mouseDown(dialog, { button: 2 })
  expect(dialog).toBeInTheDocument()
  expect(fireEvent.mouseDown(dialog, { button: 0 })).toBe(false)

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByLabelText('Dataset split')).toHaveValue('validation')
  expect(screen.getByRole('button', { name: /← previous/i })).toBeEnabled()
  expect(screen.getByRole('button', { name: /next →/i })).toBeDisabled()
  expect(fetchMock).toHaveBeenCalledTimes(5)
})

it('retries a failed gallery request', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse({ detail: 'Dataset temporarily unavailable' }, 503))
    .mockResolvedValueOnce(pageResponse([summary]))
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp()

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Dataset temporarily unavailable',
  )
  await user.click(screen.getByRole('button', { name: 'Try again' }))

  expect(
    await screen.findByRole('button', { name: /a dog runs through a green field/i }),
  ).toBeInTheDocument()
  expect(fetchMock).toHaveBeenLastCalledWith('/api/samples?limit=24&offset=0', {
    signal: expect.any(AbortSignal),
  })
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('shows an initial unfiltered empty state without a clear-filter action', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(pageResponse([]))
  vi.stubGlobal('fetch', fetchMock)

  renderApp()

  expect(await screen.findByText('No samples found')).toBeInTheDocument()
  expect(screen.getByLabelText('Dataset split')).toHaveValue('all')
  expect(
    screen.queryByRole('button', { name: 'Clear filters' }),
  ).not.toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledWith('/api/samples?limit=24&offset=0', {
    signal: expect.any(AbortSignal),
  })
})

it('returns from an empty filtered result to the unfiltered gallery', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(pageResponse([summary]))
    .mockResolvedValueOnce(pageResponse([]))
    .mockResolvedValueOnce(pageResponse([summary]))
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp()

  await screen.findByRole('button', { name: /a dog runs through a green field/i })
  await user.selectOptions(screen.getByLabelText('Dataset split'), 'validation')

  expect(await screen.findByText('No samples found')).toBeInTheDocument()
  expect(screen.getByLabelText('Dataset split')).toHaveValue('validation')
  await user.click(screen.getByRole('button', { name: 'Clear filters' }))

  expect(
    await screen.findByRole('button', { name: /a dog runs through a green field/i }),
  ).toBeInTheDocument()
  expect(screen.getByLabelText('Dataset split')).toHaveValue('all')
  expect(fetchMock).toHaveBeenLastCalledWith('/api/samples?limit=24&offset=0', {
    signal: expect.any(AbortSignal),
  })
  expect(fetchMock).toHaveBeenCalledTimes(3)
})

it('applies URL filters to the request and removes them through chips', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(pageResponse([summary]))
    .mockResolvedValueOnce(pageResponse([summary]))
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp('/?term=dog&min_ratio=1.25&max_ratio=1.5&offset=24')

  await screen.findByRole('button', { name: /a dog runs through a green field/i })
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/samples?limit=24&offset=24&term=dog&min_ratio=1.25&max_ratio=1.5',
    { signal: expect.any(AbortSignal) },
  )
  expect(screen.getByText('Exact term: “dog”')).toBeInTheDocument()
  expect(screen.getByText('Aspect ratio: 1.25–1.5')).toBeInTheDocument()

  await user.click(
    screen.getByRole('button', { name: 'Remove filter: Exact term: “dog”' }),
  )

  await waitFor(() => {
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/samples?limit=24&offset=0&min_ratio=1.25&max_ratio=1.5',
      { signal: expect.any(AbortSignal) },
    )
  })
  expect(screen.queryByText('Exact term: “dog”')).not.toBeInTheDocument()
  expect(screen.getByText('Aspect ratio: 1.25–1.5')).toBeInTheDocument()
})

it('submits and paginates a caption search while preserving other filters', async () => {
  const query = 'dog & cat'
  const searchSummary: SampleSummary = {
    ...summary,
    matched_captions: [
      'A dog & cat wait beside a gate.',
      'Another DOG & CAT run through the field.',
    ],
  }
  let resolveSearch!: (response: Response) => void
  const searchResponse = new Promise<Response>((resolve) => {
    resolveSearch = resolve
  })
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(pageResponse([summary], { total: 25, offset: 24 }))
    .mockReturnValueOnce(searchResponse)
    .mockResolvedValueOnce(pageResponse([searchSummary], { total: 25, offset: 24 }))
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp('/?split=test&term=dog&offset=24')

  await screen.findByRole('button', { name: /a dog runs through a green field/i })
  const searchInput = screen.getByRole('searchbox', { name: 'Search captions' })
  await user.type(searchInput, `  ${query}  `)
  expect(fetchMock).toHaveBeenCalledTimes(1)

  await user.click(screen.getByRole('button', { name: 'Search' }))

  expect(await screen.findByText(`Searching captions for “${query}”`)).toHaveClass(
    'visually-hidden',
  )
  expect(searchInput).toHaveValue(query)
  expect(fetchMock).toHaveBeenLastCalledWith(
    '/api/samples?limit=24&offset=0&split=test&q=dog+%26+cat&term=dog',
    { signal: expect.any(AbortSignal) },
  )

  resolveSearch(pageResponse([searchSummary], { total: 25 }))

  const resultCard = (await screen.findByText('Matched captions')).closest('article')
  expect(resultCard).not.toBeNull()
  const matches = within(resultCard as HTMLElement).getByRole('list')
  expect(matches.tagName).toBe('UL')
  expect(within(matches).getAllByRole('listitem').map((item) => item.textContent)).toEqual(
    searchSummary.matched_captions,
  )
  expect(
    [...(resultCard as HTMLElement).querySelectorAll('mark')].map(
      (mark) => mark.textContent,
    ),
  ).toEqual(['dog & cat', 'DOG & CAT'])
  const detailsButton = within(resultCard as HTMLElement).getByRole('button', {
    name: `View details for 123456789.jpg: ${searchSummary.matched_captions[0]}`,
  })
  expect(detailsButton).toBeInTheDocument()
  expect(detailsButton).not.toContainElement(matches)
  expect(screen.getByText(`Caption search: “${query}”`)).toBeInTheDocument()
  expect(screen.getByText('Exact term: “dog”')).toBeInTheDocument()
  expect(
    screen.getByText(`Showing 1–1 of 25 matching samples for “${query}”`, {
      selector: '.results-summary',
    }),
  ).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: /next →/i }))

  await waitFor(() => {
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/samples?limit=24&offset=24&split=test&q=dog+%26+cat&term=dog',
      { signal: expect.any(AbortSignal) },
    )
  })
})

it('preserves an unsubmitted draft while paginating the committed search', async () => {
  const searchSummary: SampleSummary = {
    ...summary,
    matched_captions: ['A dog runs through a green field.'],
  }
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(pageResponse([searchSummary], { total: 25 }))
    .mockResolvedValueOnce(pageResponse([searchSummary], { total: 25, offset: 24 }))
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp('/?q=dog')

  await screen.findByText('Matched captions')
  const searchInput = screen.getByRole('searchbox', { name: 'Search captions' })
  await user.clear(searchInput)
  await user.type(searchInput, 'cat')
  expect(searchInput).toHaveValue('cat')

  await user.click(screen.getByRole('button', { name: /next →/i }))

  await waitFor(() => {
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/samples?limit=24&offset=24&q=dog',
      { signal: expect.any(AbortSignal) },
    )
  })
  expect(searchInput).toHaveValue('cat')
})

it('restores the committed query when another filter changes', async () => {
  const searchSummary: SampleSummary = {
    ...summary,
    matched_captions: ['A dog runs through a green field.'],
  }
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(pageResponse([searchSummary]))
    .mockResolvedValueOnce(pageResponse([searchSummary]))
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp('/?q=dog')

  await screen.findByText('Matched captions')
  const searchInput = screen.getByRole('searchbox', { name: 'Search captions' })
  await user.clear(searchInput)
  await user.type(searchInput, 'cat')

  await user.selectOptions(screen.getByLabelText('Dataset split'), 'test')

  await waitFor(() => expect(searchInput).toHaveValue('dog'))
  expect(fetchMock).toHaveBeenLastCalledWith(
    '/api/samples?limit=24&offset=0&split=test&q=dog',
    { signal: expect.any(AbortSignal) },
  )
})

it('clears an empty caption search without dropping the split filter', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(pageResponse([], { offset: 24 }))
    .mockResolvedValueOnce(pageResponse([summary]))
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp('/?split=validation&q=missing&offset=24')

  expect(await screen.findByRole('heading', { name: 'No matching captions' })).toBeInTheDocument()
  expect(
    screen.getByText('No samples in the current filters have captions matching “missing”.'),
  ).toBeInTheDocument()
  expect(screen.getByRole('searchbox', { name: 'Search captions' })).toHaveValue('missing')
  expect(screen.getByRole('button', { name: 'Clear all filters' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Clear search' }))

  await screen.findByRole('button', { name: /a dog runs through a green field/i })
  expect(screen.getByRole('searchbox', { name: 'Search captions' })).toHaveValue('')
  expect(screen.getByLabelText('Dataset split')).toHaveValue('validation')
  expect(fetchMock).toHaveBeenLastCalledWith(
    '/api/samples?limit=24&offset=0&split=validation',
    { signal: expect.any(AbortSignal) },
  )
})

it('clears every filter from a combined empty caption search', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(pageResponse([]))
    .mockResolvedValueOnce(pageResponse([summary]))
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp('/?split=validation&q=missing&term=dog')

  await screen.findByRole('heading', { name: 'No matching captions' })
  await user.click(screen.getByRole('button', { name: 'Clear all filters' }))

  await screen.findByRole('button', { name: /a dog runs through a green field/i })
  expect(screen.getByRole('searchbox', { name: 'Search captions' })).toHaveValue('')
  expect(screen.getByLabelText('Dataset split')).toHaveValue('all')
  expect(fetchMock).toHaveBeenLastCalledWith('/api/samples?limit=24&offset=0', {
    signal: expect.any(AbortSignal),
  })
})

it('returns an out-of-range caption search to its first page', async () => {
  const searchSummary: SampleSummary = {
    ...summary,
    matched_captions: ['A dog runs through a green field.'],
  }
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(pageResponse([], { total: 1, offset: 9999 }))
    .mockResolvedValueOnce(pageResponse([searchSummary], { total: 1 }))
  vi.stubGlobal('fetch', fetchMock)

  renderApp('/?split=test&q=dog&offset=9999')

  expect(await screen.findByText('Matched captions')).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'No matching captions' })).not.toBeInTheDocument()
  expect(screen.getByLabelText('Dataset split')).toHaveValue('test')
  expect(screen.getByRole('searchbox', { name: 'Search captions' })).toHaveValue('dog')
  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    '/api/samples?limit=24&offset=9999&split=test&q=dog',
    { signal: expect.any(AbortSignal) },
  )
  expect(fetchMock).toHaveBeenLastCalledWith(
    '/api/samples?limit=24&offset=0&split=test&q=dog',
    { signal: expect.any(AbortSignal) },
  )
})

it('treats a blank search submission as clearing the query', async () => {
  const searchSummary: SampleSummary = {
    ...summary,
    matched_captions: ['A dog runs through a green field.'],
  }
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(pageResponse([searchSummary]))
    .mockResolvedValueOnce(pageResponse([summary]))
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp('/?split=test&q=dog')

  await screen.findByText('Matched captions')
  const searchInput = screen.getByRole('searchbox', { name: 'Search captions' })
  await user.clear(searchInput)
  await user.click(screen.getByRole('button', { name: 'Search' }))

  await screen.findByRole('button', { name: /a dog runs through a green field/i })
  expect(searchInput).toHaveValue('')
  expect(fetchMock).toHaveBeenLastCalledWith(
    '/api/samples?limit=24&offset=0&split=test',
    { signal: expect.any(AbortSignal) },
  )
})

it('retries a failed caption search with the committed query', async () => {
  const searchSummary: SampleSummary = {
    ...summary,
    matched_captions: ['A dog runs through a green field.'],
  }
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse({ detail: 'Search temporarily unavailable' }, 503))
    .mockResolvedValueOnce(pageResponse([searchSummary]))
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp('/?split=train&q=green+field')

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('Couldn’t search captions')
  expect(alert).toHaveTextContent('Search temporarily unavailable')
  expect(screen.getByRole('searchbox', { name: 'Search captions' })).toHaveValue(
    'green field',
  )

  await user.click(screen.getByRole('button', { name: 'Try again' }))

  await screen.findByText('Matched captions')
  expect(fetchMock).toHaveBeenLastCalledWith(
    '/api/samples?limit=24&offset=0&split=train&q=green+field',
    { signal: expect.any(AbortSignal) },
  )
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('caps an overlong query loaded from the URL', async () => {
  const query = 'a'.repeat(201)
  const normalizedQuery = 'a'.repeat(200)
  const fetchMock = vi.fn().mockResolvedValue(pageResponse([]))
  vi.stubGlobal('fetch', fetchMock)

  renderApp(`/?q=${query}`)

  expect(await screen.findByRole('heading', { name: 'No matching captions' })).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByRole('searchbox', { name: 'Search captions' })).toHaveValue(
    normalizedQuery,
  )
  expect(fetchMock).toHaveBeenCalledWith(
    `/api/samples?limit=24&offset=0&q=${normalizedQuery}`,
    { signal: expect.any(AbortSignal) },
  )
})

it('normalizes and reruns a committed query when it is resubmitted', async () => {
  const dogResult: SampleSummary = {
    ...summary,
    matched_captions: ['A dog runs through a green field.'],
  }
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(pageResponse([dogResult]))
    .mockResolvedValueOnce(pageResponse([dogResult]))
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp('/?q=dog')

  await screen.findByText('Matched captions')
  const searchInput = screen.getByRole('searchbox', { name: 'Search captions' })
  await user.clear(searchInput)
  await user.type(searchInput, ' dog ')
  await user.click(screen.getByRole('button', { name: 'Search' }))

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  expect(searchInput).toHaveValue('dog')
  expect(fetchMock).toHaveBeenLastCalledWith('/api/samples?limit=24&offset=0&q=dog', {
    signal: expect.any(AbortSignal),
  })
})

it('moves focus and title across page and chart navigation', async () => {
  const overview = {
    sample_count: 1,
    caption_count: 5,
    split_counts: { train: 1, validation: 0, test: 0 },
    caption_lengths: [],
    top_terms: [],
    widths: [],
    heights: [],
    aspect_ratios: [],
    duplicates: {
      group_count: 0,
      affected_sample_count: 0,
      cross_split_group_count: 0,
      groups: [],
    },
  }
  const fetchMock = vi.fn((input: RequestInfo | URL) =>
    Promise.resolve(
      String(input).startsWith('/api/overview')
        ? jsonResponse(overview)
        : pageResponse([summary]),
    ),
  )
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp()

  await screen.findByRole('button', { name: /a dog runs through a green field/i })
  const initialHeading = screen.getByRole('heading', { name: 'Dataset samples' })
  expect(initialHeading).not.toHaveFocus()
  expect(document.title).toBe('Browse · Flickr8k Explorer')

  await user.click(screen.getByRole('link', { name: 'Overview' }))

  const overviewHeading = await screen.findByRole('heading', {
    name: 'Dataset overview',
  })
  await waitFor(() => expect(overviewHeading).toHaveFocus())
  expect(document.title).toBe('Dataset overview · Flickr8k Explorer')
  expect(fetchMock).toHaveBeenLastCalledWith('/api/overview', {
    signal: expect.any(AbortSignal),
  })
  expect(screen.getByText('No exact-duplicate images in this dataset.')).toBeInTheDocument()

  await user.click(screen.getByRole('link', { name: 'Train 1' }))

  const galleryHeading = await screen.findByRole('heading', {
    name: 'Dataset samples',
  })
  await waitFor(() => expect(galleryHeading).toHaveFocus())
  expect(document.title).toBe('Browse · Flickr8k Explorer')
  expect(fetchMock).toHaveBeenLastCalledWith(
    '/api/samples?limit=24&offset=0&split=train',
    { signal: expect.any(AbortSignal) },
  )
})
