import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import type { SampleDetail } from '../dataset/api'
import { detail, jsonResponse } from '../test/fixtures'
import DetailPanel from './DetailPanel'

const navigationDetails: Record<string, SampleDetail> = {
  'sample-a': {
    ...detail,
    id: 'sample-a',
    source_id: 'first.jpg',
    captions: ['First sample.'],
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
  },
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.style.overflow = ''
})

function StrictModeDetailHarness() {
  const [isOpen, setIsOpen] = useState(true)

  return isOpen ? (
    <DetailPanel
      sampleId={detail.id}
      onClose={() => setIsOpen(false)}
      onNavigate={() => undefined}
    />
  ) : null
}

function NavigableDetailHarness({
  onClose = () => undefined,
}: {
  onClose?: () => void
}) {
  const [sampleId, setSampleId] = useState('sample-a')

  return (
    <DetailPanel
      sampleId={sampleId}
      onClose={onClose}
      onNavigate={setSampleId}
    />
  )
}

it('ignores a stale detail failure after navigation aborts its request', async () => {
  let rejectFirst!: (reason: unknown) => void
  const firstResponse = new Promise<Response>((_resolve, reject) => {
    rejectFirst = reject
  })
  let resolveSecond!: (response: Response) => void
  const secondResponse = new Promise<Response>((resolve) => {
    resolveSecond = resolve
  })
  const fetchMock = vi
    .fn()
    .mockReturnValueOnce(firstResponse)
    .mockReturnValueOnce(secondResponse)
  vi.stubGlobal('fetch', fetchMock)

  const { rerender } = render(
    <DetailPanel
      sampleId="sample-a"
      onClose={() => undefined}
      onNavigate={() => undefined}
    />,
  )
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  const firstRequest = fetchMock.mock.calls[0]?.[1] as { signal: AbortSignal }

  rerender(
    <DetailPanel
      sampleId="sample-b"
      onClose={() => undefined}
      onNavigate={() => undefined}
    />,
  )

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  const secondRequest = fetchMock.mock.calls[1]?.[1] as { signal: AbortSignal }
  expect(firstRequest.signal.aborted).toBe(true)
  expect(secondRequest.signal.aborted).toBe(false)

  await act(async () => {
    rejectFirst(new Error('Stale request failed'))
  })

  expect(screen.getByRole('status')).toHaveTextContent('Loading sample…')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()

  resolveSecond(
    jsonResponse({
      ...detail,
      id: 'sample-b',
      source_id: 'second.jpg',
      captions: ['Second sample.'],
    }),
  )

  expect(
    await screen.findByRole('heading', { name: 'second.jpg' }),
  ).toBeInTheDocument()
})

it('restores repeated Next navigation focus until the end of the result set', async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const id = decodeURIComponent(String(input).slice('/api/samples/'.length))
    return Promise.resolve(jsonResponse(navigationDetails[id]))
  })
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  render(<NavigableDetailHarness />)

  await screen.findByRole('heading', { name: 'first.jpg' })
  await user.click(screen.getByRole('button', { name: /next/i }))

  await screen.findByRole('heading', { name: 'middle.jpg' })
  const middleNext = screen.getByRole('button', { name: /next/i })
  expect(middleNext).toBeEnabled()
  expect(middleNext).toHaveFocus()

  await user.keyboard('{Enter}')

  await screen.findByRole('heading', { name: 'last.jpg' })
  expect(screen.getByRole('button', { name: /next/i })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Close details' })).toHaveFocus()
})

it('ignores a second Enter while button navigation is loading', async () => {
  let resolveNavigation!: (response: Response) => void
  const navigationResponse = new Promise<Response>((resolve) => {
    resolveNavigation = resolve
  })
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse(navigationDetails['sample-a']))
    .mockReturnValueOnce(navigationResponse)
  vi.stubGlobal('fetch', fetchMock)
  const onClose = vi.fn()
  const user = userEvent.setup()

  render(<NavigableDetailHarness onClose={onClose} />)

  await screen.findByRole('heading', { name: 'first.jpg' })
  const nextButton = screen.getByRole('button', { name: /next/i })
  nextButton.focus()

  await user.keyboard('{Enter}{Enter}')

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  const dialog = screen.getByRole('dialog')
  expect(dialog).toHaveAttribute('open')
  expect(dialog.querySelector('.detail-panel')).toHaveFocus()
  expect(screen.getByRole('status')).toHaveTextContent('Loading sample…')
  expect(onClose).not.toHaveBeenCalled()

  resolveNavigation(jsonResponse(navigationDetails['sample-b']))
  await screen.findByRole('heading', { name: 'middle.jpg' })
})

it('announces each sample after navigation finishes', async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const id = decodeURIComponent(String(input).slice('/api/samples/'.length))
    return Promise.resolve(jsonResponse(navigationDetails[id]))
  })
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  render(<NavigableDetailHarness />)

  await screen.findByRole('heading', { name: 'first.jpg' })
  const announcement = screen.getByText('Loaded sample first.jpg')
  expect(announcement).toHaveClass('visually-hidden')
  expect(announcement).toHaveAttribute('aria-live', 'polite')
  expect(announcement).toHaveAttribute('aria-atomic', 'true')

  await user.click(screen.getByRole('button', { name: /next/i }))

  await screen.findByRole('heading', { name: 'middle.jpg' })
  expect(announcement).toHaveTextContent('Loaded sample middle.jpg')
})

it('keeps Close focused after retrying a failed button navigation', async () => {
  let resolveRetry!: (response: Response) => void
  const retryResponse = new Promise<Response>((resolve) => {
    resolveRetry = resolve
  })
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse(navigationDetails['sample-a']))
    .mockResolvedValueOnce(jsonResponse({ detail: 'Navigation failed' }, 503))
    .mockReturnValueOnce(retryResponse)
  vi.stubGlobal('fetch', fetchMock)
  const user = userEvent.setup()

  render(<NavigableDetailHarness />)

  await screen.findByRole('heading', { name: 'first.jpg' })
  await user.click(screen.getByRole('button', { name: /next/i }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Navigation failed')
  const failedDialog = screen.getByRole('dialog')
  const closeButton = screen.getByRole('button', { name: 'Close details' })
  expect(closeButton).toHaveFocus()
  expect(failedDialog.querySelector('.detail-panel')).not.toHaveFocus()

  await user.click(screen.getByRole('button', { name: 'Try again' }))

  expect(await screen.findByRole('status')).toHaveTextContent('Loading sample…')
  expect(closeButton).toHaveFocus()

  resolveRetry(jsonResponse(navigationDetails['sample-b']))
  await screen.findByRole('heading', { name: 'middle.jpg' })
  expect(screen.getByRole('button', { name: /next/i })).toBeEnabled()
  expect(closeButton).toHaveFocus()
})

it('does not refetch detail for equivalent inline filters after a parent rerender', async () => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(detail))
  vi.stubGlobal('fetch', fetchMock)

  const { rerender } = render(
    <DetailPanel
      sampleId={detail.id}
      filters={{ split: 'train', q: 'green field' }}
      onClose={() => undefined}
      onNavigate={() => undefined}
    />,
  )

  await screen.findByRole('heading', { name: detail.source_id })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fetchMock).toHaveBeenLastCalledWith(
    '/api/samples/stable-sample-id?split=train&q=green+field',
    { signal: expect.any(AbortSignal) },
  )

  rerender(
    <DetailPanel
      sampleId={detail.id}
      filters={{ q: 'green field', split: 'train' }}
      onClose={() => undefined}
      onNavigate={() => undefined}
    />,
  )

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('heading', { name: detail.source_id })).toBeInTheDocument()
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

it('highlights the committed caption search in every caption', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(detail)))

  render(
    <DetailPanel
      sampleId={detail.id}
      filters={{ q: 'dog' }}
      onClose={() => undefined}
      onNavigate={() => undefined}
    />,
  )

  await screen.findByRole('heading', { name: detail.source_id })
  const marks = screen.getAllByText('dog', { selector: 'mark' })
  // Four of the five fixture captions mention a dog; the fifth says "animal".
  expect(marks).toHaveLength(4)
  expect(marks[0].closest('.caption-list')).not.toBeNull()
})

it('renders captions plainly without a caption search', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(detail)))

  render(
    <DetailPanel sampleId={detail.id} onClose={() => undefined} onNavigate={() => undefined} />,
  )

  await screen.findByRole('heading', { name: detail.source_id })
  expect(document.querySelector('.caption-list mark')).toBeNull()
})

it('offers to find similar images and labels scores against the reference image', async () => {
  const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ ...detail, similarity: 0.91 })))
  vi.stubGlobal('fetch', fetchMock)
  const onFindSimilar = vi.fn()
  const user = userEvent.setup()

  render(
    <DetailPanel
      sampleId={detail.id}
      filters={{ split: 'train', similar_to: 'anchor' }}
      onClose={() => undefined}
      onNavigate={() => undefined}
      onFindSimilar={onFindSimilar}
    />,
  )

  await screen.findByRole('heading', { name: detail.source_id })
  expect(fetchMock).toHaveBeenLastCalledWith(
    `/api/samples/${detail.id}?split=train&similar_to=anchor`,
    { signal: expect.any(AbortSignal) },
  )
  expect(
    screen.getByText('CLIP cosine similarity to the reference image: 0.910'),
  ).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Find similar images' }))
  expect(onFindSimilar).toHaveBeenCalledTimes(1)
})
