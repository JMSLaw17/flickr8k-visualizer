import type { DatasetSplit } from '../dataset/api'
import { splitLabels, type SplitFilter } from '../dataset/formatters'

interface SplitSelectProps {
  value: DatasetSplit | undefined
  onChange: (split: SplitFilter) => void
}

function SplitSelect({ value, onChange }: SplitSelectProps) {
  return (
    <label className="filter-control">
      <span>Dataset split</span>
      <select
        value={value ?? 'all'}
        onChange={(event) => onChange(event.target.value as SplitFilter)}
      >
        {Object.entries(splitLabels).map(([option, label]) => (
          <option key={option} value={option}>
            {label}
          </option>
        ))}
      </select>
    </label>
  )
}

export default SplitSelect
