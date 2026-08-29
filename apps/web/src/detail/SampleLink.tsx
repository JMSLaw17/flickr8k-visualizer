import { Link, useLocation, type LinkProps } from 'react-router-dom'

import { appOpenedDrawerState } from './sampleRoute'

type SampleLinkProps = Omit<LinkProps, 'state' | 'to'> & {
  sampleId: string
}

function SampleLink({ sampleId, onClick, ...props }: SampleLinkProps) {
  const location = useLocation()
  const search = new URLSearchParams(location.search)
  search.set('sample', sampleId)

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
