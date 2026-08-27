import type { SampleSummary } from '../api'
import { formatDimensions, formatSplit } from '../formatters'
import DatasetImage from './DatasetImage'

interface SampleCardProps {
  sample: SampleSummary
  onOpen: () => void
}

function SampleCard({ sample, onOpen }: SampleCardProps) {
  const caption = sample.caption || 'No caption available'

  return (
    <button className="sample-card" type="button" onClick={onOpen}>
      <div className="sample-card__media">
        <DatasetImage className="sample-card__image" src={sample.thumbnail_url} alt="" />
        <span className={`split-badge split-badge--${sample.split}`}>
          {formatSplit(sample.split)}
        </span>
      </div>
      <div className="sample-card__body">
        <p className="sample-card__caption">{caption}</p>
        <span className="sample-card__meta">
          {formatDimensions(sample.width, sample.height)}
        </span>
      </div>
    </button>
  )
}

export default SampleCard
