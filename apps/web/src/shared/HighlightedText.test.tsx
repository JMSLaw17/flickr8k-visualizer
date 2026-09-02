import { render } from '@testing-library/react'
import { expect, it } from 'vitest'

import HighlightedText from './HighlightedText'

it('highlights every standalone literal occurrence without matching inside words', () => {
  const text = 'A man, MAN-made art, woman, and another man.'
  const { container } = render(
    <p>
      <HighlightedText text={text} query="man" />
    </p>,
  )

  expect(container.textContent).toBe(text)
  expect([...container.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual([
    'man',
    'MAN',
    'man',
  ])
})

it('treats regex and HTML-like query text as safe literal content', () => {
  const text = 'A x<B>[dog].*</B>y runs past <b>[DOG].*</b>.'
  const { container } = render(
    <p>
      <HighlightedText text={text} query="<b>[dog].*</b>" />
    </p>,
  )

  expect(container.textContent).toBe(text)
  expect([...container.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual([
    '<B>[dog].*</B>',
    '<b>[DOG].*</b>',
  ])
  expect(container.querySelector('b')).not.toBeInTheDocument()
})

it('renders unchanged text for empty and absent matches', () => {
  const empty = render(<HighlightedText text="A person walks." query="" />)
  const absent = render(<HighlightedText text="A woman walks." query="man" />)

  expect(empty.container).toHaveTextContent('A person walks.')
  expect(empty.container.querySelector('mark')).not.toBeInTheDocument()
  expect(absent.container).toHaveTextContent('A woman walks.')
  expect(absent.container.querySelector('mark')).not.toBeInTheDocument()
})

it.each(['İ', 'ı', 'ſ', 'K'])('treats %s as a literal non-ASCII character', (query) => {
  const text = 'ASCII I i s k stay unchanged.'
  const { container } = render(<HighlightedText text={text} query={query} />)

  expect(container).toHaveTextContent(text)
  expect(container.querySelector('mark')).not.toBeInTheDocument()
})

it('folds ASCII case without folding non-ASCII case', () => {
  const { container } = render(<HighlightedText text="Café and CAFÉ" query="café" />)

  expect([...container.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual([
    'Café',
  ])
})
