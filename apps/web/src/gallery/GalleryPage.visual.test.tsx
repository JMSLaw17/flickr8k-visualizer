import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'

import type { SampleSummary } from '../dataset/api'
import { detail, jsonResponse, pageResponse, summary } from '../test/fixtures'
import { renderApp } from '../test/render'

const rankedItem: SampleSummary = { ...summary, similarity: 0.2839 }

it('loads a URL-ranked listing, announces progress, and labels scores', async () => {
  const second: SampleSummary = {
    ...rankedItem,
    id: 'second-sample',
    source_id: '987654321.jpg',
    caption: 'A cat sits on a porch.',
    similarity: 0.75,
  }
  let resolveListing!: (response: Response) => void
  const listingResponse = new Promise<Response>((resolve) => {
    resolveListing = resolve
  })
  const fetchMock = vi.fn().mockReturnValueOnce(listingResponse)
  vi.stubGlobal('fetch', fetchMock)

  renderApp('/?rank=a+dog+running+through+snow&split=test')

  expect(
    await screen.findByText('Ranking images by similarity to “a dog running through snow”'),
  ).toHaveClass('visually-hidden')
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/samples?limit=24&offset=0&split=test&rank=a+dog+running+through+snow',
    { signal: expect.any(AbortSignal) },
  )

  resolveListing(pageResponse([rankedItem, second]))

  const card = (await screen.findByText('CLIP cosine similarity: 0.284')).closest(
    'article',
  ) as HTMLElement
  expect(within(card).getByText('A dog runs through a green field.')).toBeInTheDocument()
  expect(card.querySelector('mark')).toBeNull()
  expect(screen.queryByText('Matched captions')).not.toBeInTheDocument()
  expect(screen.getByText('CLIP cosine similarity: 0.750')).toBeInTheDocument()
  expect(
    screen.getByText(
      'Showing 1–2 of 2 · ranked by similarity to “a dog running through snow”',
      { selector: '.results-summary' },
    ),
  ).toBeInTheDocument()
  expect(screen.getByRole('searchbox', { name: 'Filter by caption' })).toHaveValue('')
  expect(
    screen.getByRole('searchbox', { name: 'Rank by image content' }),
  ).toHaveValue('a dog running through snow')
  expect(screen.getByText('Ranked by: “a dog running through snow”')).toBeInTheDocument()
})

it('composes caption and numeric filters with ranking through pagination', async () => {
  const matchedItem: SampleSummary = {
    ...rankedItem,
    matched_captions: ['A dog jumps through snow in a green field.'],
  }
  const pageTwoItem: SampleSummary = {
    ...matchedItem,
    id: 'page-two',
    source_id: 'page-two.jpg',
    similarity: 0.1,
  }
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(pageResponse([matchedItem], { total: 25 }))
    .mockResolvedValueOnce(pageResponse([pageTwoItem], { total: 25, offset: 24 }))
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp('/?q=snow&rank=a+dog+jumping&split=train&term=dog&min_words=9')

  const matchedLabel = await screen.findByText('Matched captions')
  const card = matchedLabel.closest('article') as HTMLElement
  expect(within(card).getByText('snow')).toBeInTheDocument()
  expect(within(card).getByText('CLIP cosine similarity: 0.284')).toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/samples?limit=24&offset=0&split=train&q=snow&term=dog&min_words=9&rank=a+dog+jumping',
    { signal: expect.any(AbortSignal) },
  )
  expect(screen.getByText('Caption search: “snow”')).toBeInTheDocument()
  expect(screen.getByText('Exact term: “dog”')).toBeInTheDocument()
  expect(screen.getByText('Has a caption of 9+ tokens')).toBeInTheDocument()
  expect(screen.getByText('Ranked by: “a dog jumping”')).toBeInTheDocument()
  expect(
    screen.getByText(
      'Showing 1–1 of 25 matching samples for “snow” · ranked by similarity to “a dog jumping”',
      { selector: '.results-summary' },
    ),
  ).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: /next →/i }))

  await screen.findByText('CLIP cosine similarity: 0.100')
  expect(fetchMock).toHaveBeenLastCalledWith(
    '/api/samples?limit=24&offset=24&split=train&q=snow&term=dog&min_words=9&rank=a+dog+jumping',
    { signal: expect.any(AbortSignal) },
  )
})

it('submits both drafts together and clears the previous offset', async () => {
  const matchedItem: SampleSummary = {
    ...rankedItem,
    matched_captions: ['A dog jumps through a green field.'],
  }
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(pageResponse([summary], { total: 25, offset: 24 }))
    .mockResolvedValueOnce(pageResponse([matchedItem]))
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp('/?split=test&offset=24')

  await screen.findByRole('link', { name: /a dog runs through a green field/i })
  const captionInput = screen.getByRole('searchbox', { name: 'Filter by caption' })
  const rankInput = screen.getByRole('searchbox', { name: 'Rank by image content' })
  await user.type(captionInput, ' snow ')
  await user.type(rankInput, ' a dog jumping ')
  await user.click(screen.getByRole('button', { name: 'Search' }))

  await screen.findByText('CLIP cosine similarity: 0.284')
  expect(fetchMock).toHaveBeenLastCalledWith(
    '/api/samples?limit=24&offset=0&split=test&q=snow&rank=a+dog+jumping',
    { signal: expect.any(AbortSignal) },
  )
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(captionInput).toHaveValue('snow')
  expect(rankInput).toHaveValue('a dog jumping')
  expect(screen.getByText('Caption search: “snow”')).toBeInTheDocument()
  expect(screen.getByText('Ranked by: “a dog jumping”')).toBeInTheDocument()
})

it('removes only the rank chip and returns to unranked filtered results', async () => {
  const matchedItem: SampleSummary = {
    ...summary,
    matched_captions: ['A dog runs through snow in a green field.'],
  }
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      pageResponse([{ ...matchedItem, similarity: 0.2839 }], { total: 25, offset: 24 }),
    )
    .mockResolvedValueOnce(pageResponse([matchedItem]))
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp('/?split=train&q=snow&rank=dog&offset=24')

  await screen.findByText('CLIP cosine similarity: 0.284')
  const captionInput = screen.getByRole('searchbox', { name: 'Filter by caption' })
  await user.clear(captionInput)
  await user.type(captionInput, 'unsubmitted caption')
  await user.click(
    screen.getByRole('button', { name: 'Remove filter: Ranked by: “dog”' }),
  )

  await waitFor(() => {
    expect(screen.queryByText('CLIP cosine similarity: 0.284')).not.toBeInTheDocument()
  })
  expect(fetchMock).toHaveBeenLastCalledWith(
    '/api/samples?limit=24&offset=0&split=train&q=snow',
    { signal: expect.any(AbortSignal) },
  )
  expect(captionInput).toHaveValue('unsubmitted caption')
  expect(
    screen.getByRole('searchbox', { name: 'Rank by image content' }),
  ).toHaveValue('')
  expect(screen.getByText('Caption search: “snow”')).toBeInTheDocument()
  expect(screen.queryByText('Ranked by: “dog”')).not.toBeInTheDocument()
})

it('clears an empty caption search without dropping visual ranking', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(pageResponse([], { offset: 24 }))
    .mockResolvedValueOnce(pageResponse([rankedItem]))
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp('/?split=validation&q=missing&rank=dog&offset=24')

  await screen.findByRole('heading', { name: 'No matching captions' })
  await user.click(screen.getByRole('button', { name: 'Clear search' }))

  await screen.findByText('CLIP cosine similarity: 0.284')
  expect(screen.getByRole('searchbox', { name: 'Filter by caption' })).toHaveValue('')
  expect(screen.getByRole('searchbox', { name: 'Rank by image content' })).toHaveValue(
    'dog',
  )
  expect(screen.getByLabelText('Dataset split')).toHaveValue('validation')
  expect(screen.getByText('Ranked by: “dog”')).toBeInTheDocument()
  expect(fetchMock).toHaveBeenLastCalledWith(
    '/api/samples?limit=24&offset=0&split=validation&rank=dog',
    { signal: expect.any(AbortSignal) },
  )
})

it('retries a failed ranking with the backend detail message', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      jsonResponse(
        { detail: 'Visual search is not prepared. Run the data preparation command.' },
        503,
      ),
    )
    .mockResolvedValueOnce(pageResponse([rankedItem]))
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp('/?q=snow&rank=dog')

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('Couldn’t rank images')
  expect(alert).toHaveTextContent(
    'Visual search is not prepared. Run the data preparation command.',
  )

  await user.click(screen.getByRole('button', { name: 'Try again' }))

  await screen.findByText('CLIP cosine similarity: 0.284')
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(fetchMock).toHaveBeenLastCalledWith(
    '/api/samples?limit=24&offset=0&q=snow&rank=dog',
    { signal: expect.any(AbortSignal) },
  )
})

it('navigates the drawer in ranked order and keeps the score', async () => {
  const rankedDetail = {
    ...detail,
    previous_id: 'other-a',
    next_id: 'other-b',
    similarity: 0.2839,
  }
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const path = String(input)
    if (path.startsWith('/api/samples/')) {
      return Promise.resolve(jsonResponse(rankedDetail))
    }
    return Promise.resolve(pageResponse([rankedItem]))
  })
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp('/?split=train&rank=running')

  await user.click(
    await screen.findByRole('link', { name: /a dog runs through a green field/i }),
  )

  await screen.findByRole('heading', { name: detail.source_id })
  // The detail request carries the rank context for ranked-order neighbors.
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/samples/stable-sample-id?split=train&rank=running',
    { signal: expect.any(AbortSignal) },
  )
  const dialog = screen.getByRole('dialog')
  expect(
    within(dialog).getByText('CLIP cosine similarity: 0.284'),
  ).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /← previous/i })).toBeEnabled()

  await user.click(screen.getByRole('button', { name: /next →/i }))

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/samples/other-b?split=train&rank=running',
      { signal: expect.any(AbortSignal) },
    )
  })
})

it('disables the rank input while the visual index is not prepared', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    jsonResponse({
      total: 1,
      limit: 24,
      offset: 0,
      visual_ranking_ready: false,
      items: [summary],
    }),
  )
  vi.stubGlobal('fetch', fetchMock)

  renderApp()

  await screen.findByRole('link', { name: /a dog runs through a green field/i })
  const rankInput = screen.getByRole('searchbox', { name: 'Rank by image content' })
  expect(rankInput).toBeDisabled()
  expect(rankInput).toHaveAttribute(
    'placeholder',
    'Not prepared — run npm run prepare:data',
  )
})

it('explains how to prepare visual ranking when a ranked request fails', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    jsonResponse(
      { detail: 'Visual search is not prepared. Run the data preparation command.' },
      503,
    ),
  )
  vi.stubGlobal('fetch', fetchMock)

  renderApp('/?rank=dog')

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('Couldn’t rank images')
  expect(alert).toHaveTextContent(
    'Run npm run prepare:data to prepare the local data, then try again.',
  )
  expect(alert).not.toHaveTextContent('Make sure the local API is running')
})

it('ranks by a reference image from the URL until a description replaces it', async () => {
  const fetchMock = vi.fn(() => Promise.resolve(pageResponse([rankedItem])))
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  renderApp('/?similar_to=anchor&split=train')

  expect(
    await screen.findByText('Ranking images by similarity to image anchor'),
  ).toHaveClass('visually-hidden')
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/samples?limit=24&offset=0&split=train&similar_to=anchor',
    { signal: expect.any(AbortSignal) },
  )
  expect(
    await screen.findByText('Showing 1–1 of 1 · ranked by similarity to image anchor', {
      selector: '.results-summary',
    }),
  ).toBeInTheDocument()
  expect(screen.getByRole('list', { name: 'Active filters' })).toHaveTextContent(
    'Similar to: anchor',
  )
  expect(screen.getByRole('searchbox', { name: 'Rank by image content' })).toHaveValue('')

  // A description is the other ordering, so applying one drops the reference.
  await user.type(
    screen.getByRole('searchbox', { name: 'Rank by image content' }),
    'a dog{Enter}',
  )
  await waitFor(() => {
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/samples?limit=24&offset=0&split=train&rank=a+dog',
      { signal: expect.any(AbortSignal) },
    )
  })
  expect(screen.queryByText('Similar to: anchor')).not.toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Remove filter: Ranked by: “a dog”' }))
  await waitFor(() => {
    expect(fetchMock).toHaveBeenLastCalledWith('/api/samples?limit=24&offset=0&split=train', {
      signal: expect.any(AbortSignal),
    })
  })
})
