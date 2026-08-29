import { Link } from 'react-router-dom'
import type { CSSProperties } from 'react'

import type { DistributionBin } from '../dataset/api'

interface HistogramProps {
  bins: DistributionBin[]
  countNoun: string
  binHref: (bin: DistributionBin) => string
}

/** Column histogram; every bin links to the matching gallery page. */
function Histogram({ bins, countNoun, binHref }: HistogramProps) {
  if (bins.length === 0) {
    return <p className="muted">No data available.</p>
  }

  const maxCount = Math.max(...bins.map((bin) => bin.count), 1)
  const peak = bins.reduce((best, bin) => (bin.count > best.count ? bin : best))
  const minimumPlotWidth = bins.length * 26 - 2
  const plotStyle = {
    '--histogram-min-width': `${minimumPlotWidth}px`,
  } as CSSProperties

  return (
    <div className="histogram">
      <div className="histogram__scroll">
        <div className="histogram__plot" style={plotStyle}>
          <ul className="histogram__bars">
            {bins.map((bin) => {
              const description = `${bin.label}: ${bin.count.toLocaleString()} ${countNoun}`
              const height = `${Math.max((bin.count / maxCount) * 100, bin.count > 0 ? 2 : 0)}%`

              return (
                <li className="histogram__slot" key={bin.label}>
                  <Link
                    className="histogram__hit"
                    to={binHref(bin)}
                    title={description}
                    aria-label={`${description}. View in gallery.`}
                  >
                    <span className="histogram__bar" style={{ height }} />
                  </Link>
                </li>
              )
            })}
          </ul>
          <div className="histogram__axis" aria-hidden="true">
            <span>{bins[0].label}</span>
            <span>{bins[bins.length - 1].label}</span>
          </div>
        </div>
      </div>
      <p className="chart-note">
        Peak: {peak.label} ({peak.count.toLocaleString()} {countNoun})
      </p>
    </div>
  )
}

export default Histogram
