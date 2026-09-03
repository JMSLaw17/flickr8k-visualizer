import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import App from '../App'
import { HistoryControls, LocationProbe } from './probes'

/** Mount the whole app at a URL, with a probe for the current location. */
export function renderApp(
  initialEntry = '/',
  { historyControls = false }: { historyControls?: boolean } = {},
) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <App />
      <LocationProbe />
      {historyControls && <HistoryControls />}
    </MemoryRouter>,
  )
}

export function currentLocation(): string {
  return screen.getByTestId('location').textContent ?? ''
}
