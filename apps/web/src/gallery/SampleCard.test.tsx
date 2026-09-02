import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { expect, it } from 'vitest'

import { summary } from '../test/fixtures'
import SampleCard from './SampleCard'

function renderCard(sample = summary) {
  return render(
    <MemoryRouter>
      <SampleCard sample={sample} />
    </MemoryRouter>,
  )
}

it('shows the source id and marks byte-identical duplicates', () => {
  renderCard({ ...summary, duplicate: true })

  expect(screen.getByText('123456789.jpg')).toBeInTheDocument()
  expect(screen.getByText('Duplicate')).toBeInTheDocument()
})

it('omits the duplicate badge for unique samples', () => {
  renderCard()

  expect(screen.queryByText('Duplicate')).not.toBeInTheDocument()
})
