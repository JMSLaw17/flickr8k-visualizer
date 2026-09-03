import { useLocation, useNavigate } from 'react-router-dom'

/** Renders the current location so tests can read it. */
export function LocationProbe() {
  const { pathname, search } = useLocation()
  return (
    <span data-testid="location" hidden>
      {pathname}
      {search}
    </span>
  )
}

/** Back and forward buttons for exercising history in tests. */
export function HistoryControls() {
  const navigate = useNavigate()
  return (
    <>
      <button type="button" onClick={() => navigate(-1)}>
        Test back
      </button>
      <button type="button" onClick={() => navigate(1)}>
        Test forward
      </button>
    </>
  )
}
