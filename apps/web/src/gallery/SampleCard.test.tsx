import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { expect, it } from 'vitest'

import { summary } from '../test/fixtures'
import SampleCard from './SampleCard'

function renderCard(sample = summary, query = '') {
  return render(
    <MemoryRouter>
      <SampleCard sample={sample} query={query} />
    </MemoryRouter>,
  )
}

it('shows the source id and marks byte-identical duplicates', () => {
  renderCard({ ...summary, duplicate: true })

  expect(screen.getByText('123456789.jpg')).toBeInTheDocument()
  expect(screen.getByText('Duplicate')).toBeInTheDocument()
})

it('shows matched captions without highlighting when no text is searched', () => {
  renderCard({ ...summary, matched_captions: ['A dog runs through a green field.'] })

  expect(screen.getByText('Matched captions')).toBeInTheDocument()
  expect(screen.getByText('A dog runs through a green field.')).toBeInTheDocument()
  expect(document.querySelector('mark')).toBeNull()
})

it('highlights the searched text inside matched captions', () => {
  renderCard({ ...summary, matched_captions: ['A dog runs through a green field.'] }, 'dog')

  expect(document.querySelector('mark')).toHaveTextContent('dog')
})

it('caps the matched captions and counts the rest', () => {
  const captions = ['one', 'two', 'three', 'four', 'five']
  renderCard({ ...summary, matched_captions: captions })

  expect(screen.getByText('two')).toBeInTheDocument()
  expect(screen.queryByText('three')).not.toBeInTheDocument()
  expect(screen.getByText('+3 more matched')).toBeInTheDocument()
})

it('falls back to the first caption when nothing is reported as matched', () => {
  renderCard(summary, 'snow')

  expect(screen.queryByText('Matched captions')).not.toBeInTheDocument()
  expect(screen.getByText(summary.caption ?? '')).toBeInTheDocument()
})

it('omits the duplicate badge for unique samples', () => {
  renderCard()

  expect(screen.queryByText('Duplicate')).not.toBeInTheDocument()
})
