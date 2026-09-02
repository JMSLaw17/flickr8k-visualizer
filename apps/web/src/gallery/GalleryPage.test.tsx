import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'

import App from '../App'
import type { SampleDetail, SampleSummary } from '../dataset/api'
import { detail, jsonResponse, pageResponse, summary } from '../test/fixtures'

function renderApp(initialEntry = '/') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <App />
    </MemoryRouter>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.style.overflow = ''
  document.title = 'Flickr8k Explorer'
})

it('focuses caption search with slash except from editable controls or an open drawer', async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL) =>
    Promise.resolve(
      String(input).startsWith('/api/samples/stable-sample-id')
        ? jsonResponse(detail)
        : pageResponse([summary]),
    ),
  )
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp()

  const sampleLink = await screen.findByRole('link', {
    name: /a dog runs through a green field/i,
  })
  const galleryHeading = screen.getByRole('heading', { name: 'Dataset samples' })
  const searchInput = screen.getByRole('searchbox', { name: 'Filter by caption' })
  expect(searchInput).toHaveAttribute('aria-keyshortcuts', '/')
  galleryHeading.focus()

  expect(fireEvent.keyDown(document, { key: '/' })).toBe(false)
  expect(searchInput).toHaveFocus()
  expect(fireEvent.keyDown(searchInput, { key: '/' })).toBe(true)

  const splitSelect = screen.getByLabelText('Dataset split')
  splitSelect.focus()
  expect(fireEvent.keyDown(splitSelect, { key: '/' })).toBe(true)
  expect(splitSelect).toHaveFocus()

  galleryHeading.focus()
  expect(fireEvent.keyDown(document, { key: '/', ctrlKey: true })).toBe(true)
  expect(galleryHeading).toHaveFocus()

  await user.click(sampleLink)
  await screen.findByRole('heading', { name: detail.source_id })
  const closeButton = screen.getByRole('button', { name: 'Close details' })
  expect(closeButton).toHaveFocus()

  expect(fireEvent.keyDown(document, { key: '/' })).toBe(true)
  expect(closeButton).toHaveFocus()
  expect(searchInput).not.toHaveFocus()
})

it('paginates, resets a changed filter, and preserves gallery state after detail', async () => {
  const secondPageSummary: SampleSummary = {
    ...summary,
    id: 'second-page-sample',
    source_id: '987654321.jpg',
    split: 'validation',
    caption: 'A sample on the second page.',
    matched_captions: [],
    duplicate: false,
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

  await screen.findByRole('link', { name: /a dog runs through a green field/i })
  expect(screen.getByRole('button', { name: /← previous/i })).toBeDisabled()

  await user.click(screen.getByRole('button', { name: /next →/i }))
  const unfilteredSecondPageCard = await screen.findByRole('link', {
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

  await screen.findByRole('link', { name: /a dog runs through a green field/i })
  expect(screen.getByRole('button', { name: /← previous/i })).toBeDisabled()

  await user.click(screen.getByRole('button', { name: /next →/i }))
  const filteredSecondPageCard = await screen.findByRole('link', {
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
    await screen.findByRole('link', { name: /a dog runs through a green field/i }),
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

  await screen.findByRole('link', { name: /a dog runs through a green field/i })
  await user.selectOptions(screen.getByLabelText('Dataset split'), 'validation')

  expect(await screen.findByText('No samples found')).toBeInTheDocument()
  expect(screen.getByLabelText('Dataset split')).toHaveValue('validation')
  await user.click(screen.getByRole('button', { name: 'Clear filters' }))

  expect(
    await screen.findByRole('link', { name: /a dog runs through a green field/i }),
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

  await screen.findByRole('link', { name: /a dog runs through a green field/i })
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

  await screen.findByRole('link', { name: /a dog runs through a green field/i })
  const searchInput = screen.getByRole('searchbox', { name: 'Filter by caption' })
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
  const detailsButton = within(resultCard as HTMLElement).getByRole('link', {
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
  const searchInput = screen.getByRole('searchbox', { name: 'Filter by caption' })
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
  const searchInput = screen.getByRole('searchbox', { name: 'Filter by caption' })
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
  expect(screen.getByRole('searchbox', { name: 'Filter by caption' })).toHaveValue('missing')
  expect(screen.getByRole('button', { name: 'Clear all filters' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Clear search' }))

  await screen.findByRole('link', { name: /a dog runs through a green field/i })
  expect(screen.getByRole('searchbox', { name: 'Filter by caption' })).toHaveValue('')
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

  await screen.findByRole('link', { name: /a dog runs through a green field/i })
  expect(screen.getByRole('searchbox', { name: 'Filter by caption' })).toHaveValue('')
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
  expect(screen.getByRole('searchbox', { name: 'Filter by caption' })).toHaveValue('dog')
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
  const searchInput = screen.getByRole('searchbox', { name: 'Filter by caption' })
  await user.clear(searchInput)
  await user.click(screen.getByRole('button', { name: 'Search' }))

  await screen.findByRole('link', { name: /a dog runs through a green field/i })
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
  expect(screen.getByRole('searchbox', { name: 'Filter by caption' })).toHaveValue(
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
  expect(screen.getByRole('searchbox', { name: 'Filter by caption' })).toHaveValue(
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
  const searchInput = screen.getByRole('searchbox', { name: 'Filter by caption' })
  await user.clear(searchInput)
  await user.type(searchInput, ' dog ')
  await user.click(screen.getByRole('button', { name: 'Search' }))

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  expect(searchInput).toHaveValue('dog')
  expect(fetchMock).toHaveBeenLastCalledWith('/api/samples?limit=24&offset=0&q=dog', {
    signal: expect.any(AbortSignal),
  })
})
