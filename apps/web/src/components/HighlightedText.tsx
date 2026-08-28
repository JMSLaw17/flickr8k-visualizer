import type { ReactNode } from 'react'

interface HighlightedTextProps {
  text: string
  query: string
}

function HighlightedText({ text, query }: HighlightedTextProps) {
  if (!query) return <>{text}</>

  const normalizedText = foldAsciiCase(text)
  const normalizedQuery = foldAsciiCase(query)
  const parts: ReactNode[] = []
  const needsLeadingBoundary = isAsciiAlphanumeric(query[0])
  const needsTrailingBoundary = isAsciiAlphanumeric(query[query.length - 1])
  let cursor = 0
  let searchFrom = 0

  while (searchFrom < text.length) {
    const start = normalizedText.indexOf(normalizedQuery, searchFrom)
    if (start === -1) break

    const end = start + query.length

    if (
      (needsLeadingBoundary && isAsciiAlphanumeric(text[start - 1])) ||
      (needsTrailingBoundary && isAsciiAlphanumeric(text[end]))
    ) {
      searchFrom = start + 1
      continue
    }

    searchFrom = end
    if (start > cursor) parts.push(text.slice(cursor, start))
    parts.push(<mark key={start}>{text.slice(start, end)}</mark>)
    cursor = end
  }

  if (cursor === 0) return <>{text}</>
  if (cursor < text.length) parts.push(text.slice(cursor))

  return <>{parts}</>
}

function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase())
}

function isAsciiAlphanumeric(value: string | undefined): boolean {
  if (!value) return false

  const code = value.charCodeAt(0)
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  )
}

export default HighlightedText
