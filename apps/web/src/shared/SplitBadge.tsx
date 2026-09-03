import type { DatasetSplit } from '../dataset/api'
import { formatSplit } from '../dataset/formatters'

function SplitBadge({ split }: { split: DatasetSplit }) {
  return <span className={`split-badge split-badge--${split}`}>{formatSplit(split)}</span>
}

export default SplitBadge
