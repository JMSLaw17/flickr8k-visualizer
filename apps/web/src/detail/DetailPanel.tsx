import { useEffect, useRef, useState } from 'react'

import {
  filterSearchParams,
  getSample,
  type SampleDetail,
  type SampleDetailParams,
} from '../dataset/api'
import { parseRank, parseSampleFilters } from '../dataset/filters'
import {
  formatDimensions,
  formatFileDescription,
  formatSimilarity,
  formatSplit,
  getErrorMessage,
} from '../dataset/formatters'
import DatasetImage from '../shared/DatasetImage'
import HighlightedText from '../shared/HighlightedText'
import { isEditableTarget } from '../shared/interaction'

type LoadState = 'loading' | 'ready' | 'error'
type NavigationDirection = 'previous' | 'next'

interface DetailPanelProps {
  sampleId: string
  filters?: SampleDetailParams
  onClose: () => void
  onNavigate: (id: string) => void
}

const EMPTY_FILTERS: SampleDetailParams = {}

function DetailPanel({
  sampleId,
  filters = EMPTY_FILTERS,
  onClose,
  onNavigate,
}: DetailPanelProps) {
  const [sample, setSample] = useState<SampleDetail | null>(null)
  const [status, setStatus] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [requestVersion, setRequestVersion] = useState(0)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const previousButtonRef = useRef<HTMLButtonElement>(null)
  const nextButtonRef = useRef<HTMLButtonElement>(null)
  const pendingNavigationFocus = useRef<NavigationDirection | null>(null)
  const readySample = status === 'ready' && sample?.id === sampleId ? sample : null
  // Key requests by filter and rank values, not the caller's object identity.
  const filtersQuery = filterSearchParams(filters)
  if (filters.rank) filtersQuery.set('rank', filters.rank)
  const filtersKey = filtersQuery.toString()

  const closeDetail = () => {
    if (dialogRef.current?.open) dialogRef.current.close()
    onClose()
  }

  const navigateTo = (
    id: string | null,
    returnFocusTo: NavigationDirection | null = null,
  ) => {
    if (!id) return
    pendingNavigationFocus.current = returnFocusTo
    if (returnFocusTo) panelRef.current?.focus({ preventScroll: true })
    else closeButtonRef.current?.focus({ preventScroll: true })
    onNavigate(id)
  }

  useEffect(() => {
    const controller = new AbortController()
    if (panelRef.current) panelRef.current.scrollTop = 0
    setSample(null)
    setStatus('loading')
    setError('')

    const params = new URLSearchParams(filtersKey)
    const requestFilters: SampleDetailParams = parseSampleFilters(params)
    const rank = parseRank(params)
    if (rank) requestFilters.rank = rank
    getSample(sampleId, requestFilters, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        setSample(result)
        setStatus('ready')
      })
      .catch((reason: unknown) => {
        if (
          controller.signal.aborted ||
          (reason instanceof DOMException && reason.name === 'AbortError')
        ) {
          return
        }
        pendingNavigationFocus.current = null
        closeButtonRef.current?.focus({ preventScroll: true })
        setError(getErrorMessage(reason))
        setStatus('error')
      })

    return () => controller.abort()
  }, [filtersKey, requestVersion, sampleId])

  useEffect(() => {
    const direction = pendingNavigationFocus.current
    if (!readySample || !direction) return

    const button =
      direction === 'previous' ? previousButtonRef.current : nextButtonRef.current
    if (button && !button.disabled) button.focus({ preventScroll: true })
    else closeButtonRef.current?.focus({ preventScroll: true })
    pendingNavigationFocus.current = null
  }, [readySample])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.showModal()
    closeButtonRef.current?.focus({ preventScroll: true })

    return () => {
      document.body.style.overflow = previousOverflow
      if (dialog.open) dialog.close()
    }
  }, [])

  return (
    <dialog
      ref={dialogRef}
      className="detail-dialog"
      aria-label={readySample ? undefined : 'Sample details'}
      aria-labelledby={readySample ? 'detail-title' : undefined}
      onCancel={(event) => {
        event.preventDefault()
        closeDetail()
      }}
      onMouseDown={(event) => {
        if (event.button === 0 && event.target === event.currentTarget) {
          event.preventDefault()
          closeDetail()
        }
      }}
      onKeyDown={(event) => {
        if (
          event.defaultPrevented ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          isEditableTarget(event.target)
        ) {
          return
        }

        if (event.key === 'ArrowLeft' && readySample?.previous_id) {
          event.preventDefault()
          navigateTo(readySample.previous_id)
        } else if (event.key === 'ArrowRight' && readySample?.next_id) {
          event.preventDefault()
          navigateTo(readySample.next_id)
        }
      }}
    >
      <section
        ref={panelRef}
        className={`detail-panel${status === 'loading' ? ' detail-panel--loading' : ''}`}
        tabIndex={-1}
      >
        <p className="visually-hidden" aria-live="polite" aria-atomic="true">
          {readySample ? `Loaded sample ${readySample.source_id}` : ''}
        </p>
        <div className="detail-close-anchor">
          <button
            ref={closeButtonRef}
            className="detail-close"
            type="button"
            onClick={closeDetail}
            aria-label="Close details"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        {status === 'loading' && (
          <div className="detail-loading" role="status">
            <span className="spinner" aria-hidden="true" />
            Loading sample…
          </div>
        )}

        {status === 'error' && (
          <div className="detail-message" role="alert">
            <p className="detail-message__title">Couldn’t load this sample</p>
            <p>{error}</p>
            <button
              className="button button--primary"
              type="button"
              onClick={() => {
                closeButtonRef.current?.focus()
                setRequestVersion((value) => value + 1)
              }}
            >
              Try again
            </button>
          </div>
        )}

        {readySample && (
          <div className="detail-layout">
            <div className="detail-image-wrap">
              <DatasetImage
                className="detail-image"
                src={readySample.image_url}
                alt={readySample.captions[0] ?? 'Flickr8k sample'}
                width={readySample.width}
                height={readySample.height}
                eager
              />
            </div>

            <div className="detail-content">
              <div className="detail-heading">
                <span className={`split-badge split-badge--${readySample.split}`}>
                  {formatSplit(readySample.split)}
                </span>
                <p className="eyebrow">Dataset sample</p>
                <h2 id="detail-title">{readySample.source_id}</h2>
                {typeof readySample.similarity === 'number' && (
                  <p className="detail-similarity">
                    CLIP cosine similarity: {formatSimilarity(readySample.similarity)}
                  </p>
                )}
              </div>

              <nav className="detail-navigation" aria-label="Sample navigation">
                <button
                  ref={previousButtonRef}
                  className="button button--secondary"
                  type="button"
                  disabled={!readySample.previous_id}
                  aria-keyshortcuts="ArrowLeft"
                  onClick={() => navigateTo(readySample.previous_id, 'previous')}
                >
                  ← Previous
                </button>
                <button
                  ref={nextButtonRef}
                  className="button button--secondary"
                  type="button"
                  disabled={!readySample.next_id}
                  aria-keyshortcuts="ArrowRight"
                  onClick={() => navigateTo(readySample.next_id, 'next')}
                >
                  Next →
                </button>
              </nav>

              <section className="caption-section" aria-labelledby="captions-title">
                <div className="section-heading">
                  <h3 id="captions-title">Captions</h3>
                  <span>{readySample.captions.length}</span>
                </div>
                {readySample.captions.length > 0 ? (
                  <ul className="caption-list">
                    {readySample.captions.map((caption, index) => (
                      <li key={`${caption}-${index}`}>
                        <HighlightedText text={caption} query={filters.q ?? ''} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">No captions available.</p>
                )}
              </section>

              <section className="metadata-section" aria-labelledby="metadata-title">
                <h3 id="metadata-title">Metadata</h3>
                <dl className="metadata-list">
                  <div>
                    <dt>Dimensions</dt>
                    <dd>{formatDimensions(readySample.width, readySample.height)} px</dd>
                  </div>
                  <div>
                    <dt>Stable ID</dt>
                    <dd title={readySample.id}>{readySample.id}</dd>
                  </div>
                  <div>
                    <dt>SHA-256</dt>
                    <dd title={readySample.content_sha256}>{readySample.content_sha256}</dd>
                  </div>
                  <div>
                    <dt>File</dt>
                    <dd>
                      {formatFileDescription(readySample.mime_type, readySample.file_size_bytes)}
                    </dd>
                  </div>
                </dl>
              </section>
            </div>
          </div>
        )}
      </section>
    </dialog>
  )
}

export default DetailPanel
