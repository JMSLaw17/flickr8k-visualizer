import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'

import type { DatasetOverview, SampleDetail, SampleSummary } from '../../dataset/api'
import { detail, jsonResponse, pageResponse, summary } from '../fixtures'
import { currentLocation, renderApp } from '../render'

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

  const sampleCard = await screen.findByRole('link', {
    name: /a dog runs through a green field/i,
  })
  expect(
    screen.getByText(/showing 1–1 of 1/i, { selector: '.results-summary' }),
  ).toBeInTheDocument()

  const showModal = HTMLDialogElement.prototype.showModal
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    showModal.call(this)
    sampleCard.focus()
  })

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
  expect(screen.getByText('image/jpeg · 120 KB')).toBeInTheDocument()
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

  const sampleCard = await screen.findByRole('link', {
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

it('opens and closes a direct filtered sample URL without refetching the gallery', async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    return Promise.resolve(
      url.startsWith('/api/samples/stable-sample-id')
        ? jsonResponse(detail)
        : pageResponse([summary], { total: 25, offset: 24 }),
    )
  })
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp('/?split=train&q=dog&offset=24&sample=stable-sample-id')

  await screen.findByRole('link', { name: /a dog runs through a green field/i })
  expect(
    await screen.findByRole('heading', { name: detail.source_id }),
  ).toBeInTheDocument()
  expect(currentLocation()).toBe(
    '/?split=train&q=dog&offset=24&sample=stable-sample-id',
  )
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/samples?limit=24&offset=24&split=train&q=dog',
    { signal: expect.any(AbortSignal) },
  )
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/samples/stable-sample-id?split=train&q=dog',
    { signal: expect.any(AbortSignal) },
  )

  await user.click(screen.getByRole('button', { name: 'Close details' }))

  await waitFor(() => {
    expect(currentLocation()).toBe('/?split=train&q=dog&offset=24')
  })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Dataset samples' })).toHaveFocus()
  })
  expect(
    fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith('/api/samples?'),
    ),
  ).toHaveLength(1)
})

it('keeps the new route heading focused when leaving an app-opened drawer', async () => {
  const pendingFrames = new Map<number, FrameRequestCallback>()
  let nextFrameId = 0
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      nextFrameId += 1
      pendingFrames.set(nextFrameId, callback)
      return nextFrameId
    }),
  )
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((frameId: number) => pendingFrames.delete(frameId)),
  )

  const routeOverview: DatasetOverview = {
    sample_count: 1,
    caption_count: detail.captions.length,
    split_counts: { train: 1, validation: 0, test: 0 },
    caption_lengths: [],
    top_terms: [],
    dimensions: { top: [], other_sample_count: 0, other_size_count: 0 },
    aspect_ratios: [],
    duplicates: {
      group_count: 1,
      affected_sample_count: 1,
      cross_split_group_count: 0,
      groups: [
        {
          content_sha256: detail.content_sha256,
          sample_count: 1,
          splits: ['train'],
          cross_split: false,
          samples: [
            {
              id: summary.id,
              source_id: summary.source_id,
              split: summary.split,
              thumbnail_url: summary.thumbnail_url,
            },
          ],
        },
      ],
    },
  }
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/api/overview') return Promise.resolve(jsonResponse(routeOverview))
    if (url.startsWith(`/api/samples/${summary.id}`)) {
      return Promise.resolve(jsonResponse(detail))
    }
    return Promise.resolve(pageResponse([summary]))
  })
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp()

  await user.click(
    await screen.findByRole('link', { name: /a dog runs through a green field/i }),
  )
  await screen.findByRole('heading', { name: detail.source_id })

  await user.click(screen.getByRole('link', { name: 'Overview' }))

  const overviewHeading = await screen.findByRole('heading', {
    name: 'Dataset overview',
  })
  const matchingOpener = await screen.findByRole('link', {
    name: `View details for ${summary.source_id}`,
  })
  await waitFor(() => expect(overviewHeading).toHaveFocus())

  act(() => {
    for (const [frameId, callback] of pendingFrames) {
      pendingFrames.delete(frameId)
      callback(0)
    }
  })

  expect(currentLocation()).toBe('/overview')
  expect(overviewHeading).toHaveFocus()
  expect(matchingOpener).not.toHaveFocus()
})

it('replaces sample history while navigating without wrapping or replacing the grid', async () => {
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (
    this: HTMLDialogElement,
    returnValue = '',
  ) {
    this.returnValue = returnValue
    this.removeAttribute('open')
  })

  const middleSummary: SampleSummary = {
    ...summary,
    id: 'sample-b',
    source_id: 'middle.jpg',
    caption: 'Middle sample.',
    matched_captions: ['Middle sample.'],
  }
  const detailsById: Record<string, SampleDetail> = {
    'sample-a': {
      ...detail,
      id: 'sample-a',
      source_id: 'first.jpg',
      captions: ['First sample.'],
      previous_id: null,
      next_id: 'sample-b',
    },
    'sample-b': {
      ...detail,
      id: 'sample-b',
      source_id: 'middle.jpg',
      captions: ['Middle sample.'],
      previous_id: 'sample-a',
      next_id: 'sample-c',
    },
    'sample-c': {
      ...detail,
      id: 'sample-c',
      source_id: 'last.jpg',
      captions: ['Last sample.'],
      previous_id: 'sample-b',
      next_id: null,
    },
  }
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('/api/samples?')) {
      return Promise.resolve(
        pageResponse([middleSummary], { total: 25, offset: 24 }),
      )
    }

    const id = decodeURIComponent(url.slice('/api/samples/'.length).split('?')[0])
    return Promise.resolve(jsonResponse(detailsById[id]))
  })
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp('/?split=test&q=common&offset=24', { historyControls: true })

  const sampleLink = await screen.findByRole('link', { name: /middle sample/i })
  const grid = sampleLink.closest('.gallery-grid')
  await user.click(sampleLink)

  expect(
    await screen.findByRole('heading', { name: 'middle.jpg' }),
  ).toBeInTheDocument()
  expect(currentLocation()).toBe(
    '/?split=test&q=common&offset=24&sample=sample-b',
  )
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/samples/sample-b?split=test&q=common',
    { signal: expect.any(AbortSignal) },
  )
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByRole('button', { name: /previous/i })).toBeEnabled()
  expect(within(dialog).getByRole('button', { name: /next/i })).toBeEnabled()

  expect(fireEvent.keyDown(dialog, { key: 'ArrowRight' })).toBe(false)
  expect(
    await screen.findByRole('heading', { name: 'last.jpg' }),
  ).toBeInTheDocument()
  expect(currentLocation()).toBe(
    '/?split=test&q=common&offset=24&sample=sample-c',
  )
  expect(within(dialog).getByRole('button', { name: /next/i })).toBeDisabled()

  const callsAtLastSample = fetchMock.mock.calls.length
  expect(fireEvent.keyDown(dialog, { key: 'ArrowRight' })).toBe(true)
  expect(fetchMock).toHaveBeenCalledTimes(callsAtLastSample)

  await user.click(within(dialog).getByRole('button', { name: /previous/i }))
  expect(
    await screen.findByRole('heading', { name: 'middle.jpg' }),
  ).toBeInTheDocument()
  expect(fireEvent.keyDown(dialog, { key: 'ArrowLeft' })).toBe(false)
  expect(
    await screen.findByRole('heading', { name: 'first.jpg' }),
  ).toBeInTheDocument()
  expect(currentLocation()).toBe(
    '/?split=test&q=common&offset=24&sample=sample-a',
  )
  expect(within(dialog).getByRole('button', { name: /previous/i })).toBeDisabled()

  const callsAtFirstSample = fetchMock.mock.calls.length
  expect(fireEvent.keyDown(dialog, { key: 'ArrowLeft' })).toBe(true)
  expect(fireEvent.keyDown(dialog, { key: 'ArrowRight', shiftKey: true })).toBe(true)
  expect(fetchMock).toHaveBeenCalledTimes(callsAtFirstSample)

  await user.click(screen.getByRole('button', { name: 'Test back' }))

  await waitFor(() => {
    expect(currentLocation()).toBe('/?split=test&q=common&offset=24')
  })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await waitFor(() => expect(sampleLink).toHaveFocus())
  expect(sampleLink.closest('.gallery-grid')).toBe(grid)
  expect(
    fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith('/api/samples?'),
    ),
  ).toHaveLength(1)

  await user.click(screen.getByRole('button', { name: 'Test forward' }))

  expect(
    await screen.findByRole('heading', { name: 'first.jpg' }),
  ).toBeInTheDocument()
  expect(currentLocation()).toBe(
    '/?split=test&q=common&offset=24&sample=sample-a',
  )
  expect(
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true })),
  ).toBe(false)
  await waitFor(() => {
    expect(currentLocation()).toBe('/?split=test&q=common&offset=24')
  })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
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
    await screen.findByRole('link', { name: /a dog runs through a green field/i }),
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

it('moves focus and title across page and chart navigation', async () => {
  const overview = {
    sample_count: 1,
    caption_count: 5,
    split_counts: { train: 1, validation: 0, test: 0 },
    caption_lengths: [],
    top_terms: [],
    dimensions: { top: [], other_sample_count: 0, other_size_count: 0 },
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

  await screen.findByRole('link', { name: /a dog runs through a green field/i })
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

it('keeps the filter scope when switching pages and drops page-specific state', async () => {
  const overview = {
    sample_count: 1,
    caption_count: 5,
    split_counts: { train: 1, validation: 0, test: 0 },
    caption_lengths: [],
    top_terms: [],
    dimensions: { top: [], other_sample_count: 0, other_size_count: 0 },
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

  renderApp('/?split=train&q=snow&rank=a+dog&offset=24')
  await screen.findByRole('link', { name: /a dog runs through a green field/i })

  expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute(
    'href',
    '/overview?split=train&q=snow&rank=a+dog',
  )
  await user.click(screen.getByRole('link', { name: 'Overview' }))

  await screen.findByRole('heading', { name: 'Samples' })
  // The ranking stays in the URL for the trip back; the overview ignores it.
  expect(currentLocation()).toBe('/overview?split=train&q=snow&rank=a+dog')
  expect(fetchMock).toHaveBeenLastCalledWith('/api/overview?split=train&q=snow', {
    signal: expect.any(AbortSignal),
  })

  await user.click(screen.getByRole('link', { name: 'Browse' }))

  await screen.findByRole('link', { name: /a dog runs through a green field/i })
  expect(currentLocation()).toBe('/?split=train&q=snow&rank=a+dog')
  expect(fetchMock).toHaveBeenLastCalledWith(
    '/api/samples?limit=24&offset=0&split=train&q=snow&rank=a+dog',
    { signal: expect.any(AbortSignal) },
  )
})

it('carries a reference-image ordering across the page navigation', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(pageResponse([summary]))))

  renderApp('/?split=train&similar_to=anchor&offset=24')
  await screen.findByRole('link', { name: /a dog runs through a green field/i })

  expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute(
    'href',
    '/overview?split=train&similar_to=anchor',
  )
  expect(screen.getByRole('link', { name: 'Browse' })).toHaveAttribute(
    'href',
    '/?split=train&similar_to=anchor',
  )
})

it('opens similar images from the drawer, keeping the scope and focusing the gallery', async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL) =>
    Promise.resolve(
      String(input).startsWith(`/api/samples/${summary.id}`)
        ? jsonResponse(detail)
        : pageResponse([summary]),
    ),
  )
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp('/?split=train&q=snow')
  await user.click(
    await screen.findByRole('link', { name: /a dog runs through a green field/i }),
  )
  await screen.findByRole('heading', { name: detail.source_id })

  await user.click(screen.getByRole('button', { name: 'Find similar images' }))

  await waitFor(() => {
    expect(currentLocation()).toBe(`/?split=train&q=snow&similar_to=${summary.id}`)
  })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(fetchMock).toHaveBeenLastCalledWith(
    `/api/samples?limit=24&offset=0&split=train&q=snow&similar_to=${summary.id}`,
    { signal: expect.any(AbortSignal) },
  )
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Dataset samples' })).toHaveFocus()
  })
})

it('ranks the whole dataset when finding images similar to a duplicate member', async () => {
  const overview: DatasetOverview = {
    sample_count: 1,
    caption_count: 5,
    split_counts: { train: 1, validation: 0, test: 0 },
    caption_lengths: [],
    top_terms: [],
    dimensions: { top: [], other_sample_count: 0, other_size_count: 0 },
    aspect_ratios: [],
    duplicates: {
      group_count: 1,
      affected_sample_count: 2,
      cross_split_group_count: 0,
      groups: [
        {
          content_sha256: detail.content_sha256,
          sample_count: 2,
          splits: ['train'],
          cross_split: false,
          samples: [
            {
              id: summary.id,
              source_id: summary.source_id,
              split: summary.split,
              thumbnail_url: summary.thumbnail_url,
            },
          ],
        },
      ],
    },
  }
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('/api/overview')) return Promise.resolve(jsonResponse(overview))
    if (url.startsWith(`/api/samples/${summary.id}`)) {
      return Promise.resolve(jsonResponse(detail))
    }
    return Promise.resolve(pageResponse([summary]))
  })
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp('/overview?q=snow')
  await user.click(
    await screen.findByRole('link', { name: `View details for ${summary.source_id}` }),
  )
  await screen.findByRole('heading', { name: detail.source_id })
  expect(currentLocation()).toBe(`/overview?q=snow&sample=${summary.id}&scope=dataset`)

  await user.click(screen.getByRole('button', { name: 'Find similar images' }))

  // The duplicate drawer is unscoped, so its similar images span every split.
  await waitFor(() => {
    expect(currentLocation()).toBe(`/?similar_to=${summary.id}`)
  })
  expect(fetchMock).toHaveBeenLastCalledWith(
    `/api/samples?limit=24&offset=0&similar_to=${summary.id}`,
    { signal: expect.any(AbortSignal) },
  )
  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Dataset samples' })).toHaveFocus()
  })
})
