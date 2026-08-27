import { useEffect, useState } from 'react'

import { getSample, type SampleDetail } from '../api'
import {
  formatDimensions,
  formatFileDescription,
  formatSplit,
  getErrorMessage,
} from '../formatters'
import DatasetImage from './DatasetImage'

type LoadState = 'loading' | 'ready' | 'error'

interface DetailPanelProps {
  sampleId: string
  onClose: () => void
}

function DetailPanel({ sampleId, onClose }: DetailPanelProps) {
  const [sample, setSample] = useState<SampleDetail | null>(null)
  const [status, setStatus] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [requestVersion, setRequestVersion] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')
    setError('')

    getSample(sampleId, controller.signal)
      .then((result) => {
        setSample(result)
        setStatus('ready')
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        setError(getErrorMessage(reason))
        setStatus('error')
      })

    return () => controller.abort()
  }, [requestVersion, sampleId])

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  return (
    <div
      className="detail-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      {status === 'loading' ? (
        <div className="detail-loading" role="status">
          <span className="spinner" aria-hidden="true" />
          Loading sample…
        </div>
      ) : (
        <section
          className="detail-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Sample details"
        >
          <button
            className="detail-close"
            type="button"
            onClick={onClose}
            aria-label="Close details"
            autoFocus
          >
            <span aria-hidden="true">×</span>
          </button>

          {status === 'error' && (
            <div className="detail-message">
              <p className="detail-message__title">Couldn’t load this sample</p>
              <p>{error}</p>
              <button
                className="button button--primary"
                type="button"
                onClick={() => setRequestVersion((value) => value + 1)}
              >
                Try again
              </button>
            </div>
          )}

          {status === 'ready' && sample && (
            <div className="detail-layout">
              <div className="detail-image-wrap">
                <DatasetImage
                  className="detail-image"
                  src={sample.image_url}
                  alt={sample.captions[0] ?? 'Flickr8k sample'}
                  width={sample.width}
                  height={sample.height}
                  eager
                />
              </div>

              <div className="detail-content">
                <div className="detail-heading">
                  <span className={`split-badge split-badge--${sample.split}`}>
                    {formatSplit(sample.split)}
                  </span>
                  <p className="eyebrow">Dataset sample</p>
                  <h2 id="detail-title">{sample.source_id}</h2>
                </div>

                <section className="caption-section" aria-labelledby="captions-title">
                  <div className="section-heading">
                    <h3 id="captions-title">Captions</h3>
                    <span>{sample.captions.length}</span>
                  </div>
                  {sample.captions.length > 0 ? (
                    <ul className="caption-list">
                      {sample.captions.map((caption, index) => (
                        <li key={`${caption}-${index}`}>{caption}</li>
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
                      <dd>{formatDimensions(sample.width, sample.height)} px</dd>
                    </div>
                    <div>
                      <dt>Stable ID</dt>
                      <dd title={sample.id}>{sample.id}</dd>
                    </div>
                    <div>
                      <dt>SHA-256</dt>
                      <dd title={sample.content_sha256}>{sample.content_sha256}</dd>
                    </div>
                    <div>
                      <dt>File</dt>
                      <dd>{formatFileDescription(sample.mime_type, sample.file_size_bytes)}</dd>
                    </div>
                  </dl>
                </section>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  )
}

export default DetailPanel
