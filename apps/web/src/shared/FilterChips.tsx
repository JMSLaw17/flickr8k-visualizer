import type { FilterChip } from '../dataset/filters'

interface FilterChipsProps {
  chips: FilterChip[]
  onRemove: (chip: FilterChip) => void
}

/** Removable chips for the filters in effect; renders nothing without any. */
function FilterChips({ chips, onRemove }: FilterChipsProps) {
  if (chips.length === 0) return null

  return (
    <ul className="filter-chips" aria-label="Active filters">
      {chips.map((chip) => (
        <li className="filter-chip" key={chip.keys.join('-')}>
          <span>{chip.label}</span>
          <button
            type="button"
            aria-label={`Remove filter: ${chip.label}`}
            onClick={() => onRemove(chip)}
          >
            <span aria-hidden="true">×</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

export default FilterChips
