import { Link, useLocation, type LinkProps } from 'react-router-dom'

import { appOpenedDrawerState, markUnscopedDrawer } from './sampleRoute'

type SampleLinkProps = Omit<LinkProps, 'state' | 'to'> & {
  sampleId: string
  /**
   * Open the drawer over the whole dataset instead of the page's filters.
   * The filters stay in the URL so the page underneath keeps its scope; only
   * the drawer reads the marker.
   */
  unscoped?: boolean
}

function SampleLink({ sampleId, unscoped = false, onClick, ...props }: SampleLinkProps) {
  const location = useLocation()
  const search = new URLSearchParams(location.search)
  search.set('sample', sampleId)
  if (unscoped) markUnscopedDrawer(search)

  return (
    <Link
      {...props}
      to={{ pathname: location.pathname, search: `?${search}`, hash: location.hash }}
      state={appOpenedDrawerState(location.state, sampleId)}
      data-sample-opener={sampleId}
      preventScrollReset
      onClick={(event) => {
        // Safari and Firefox may not focus a clicked link, so preserve a reliable opener.
        event.currentTarget.focus({ preventScroll: true })
        onClick?.(event)
      }}
    />
  )
}

export default SampleLink
