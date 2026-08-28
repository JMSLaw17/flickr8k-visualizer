import { Link } from 'react-router-dom'

export interface BarListItem {
  key: string
  label: string
  count: number
  href: string
}

interface BarListProps {
  items: BarListItem[]
  columns?: boolean
}

/** Horizontal labeled bars; every row links to the matching gallery page. */
function BarList({ items, columns = false }: BarListProps) {
  if (items.length === 0) {
    return <p className="muted">No data available.</p>
  }

  const maxCount = Math.max(...items.map((item) => item.count), 1)

  return (
    <ul className={`bar-list${columns ? ' bar-list--columns' : ''}`}>
      {items.map((item) => (
        <li key={item.key}>
          <Link
            className="bar-list__row"
            to={item.href}
            title={`View “${item.label}” samples in the gallery`}
          >
            <span className="bar-list__label">{item.label}</span>
            <span className="bar-list__track" aria-hidden="true">
              <span
                className="bar-list__bar"
                style={{ width: `${(item.count / maxCount) * 100}%` }}
              />
            </span>
            <span className="bar-list__count">{item.count.toLocaleString()}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

export default BarList
