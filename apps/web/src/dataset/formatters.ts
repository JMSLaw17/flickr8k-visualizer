import type { DatasetSplit } from './api'

export type SplitFilter = DatasetSplit | 'all'

export const splitLabels: Record<SplitFilter, string> = {
  all: 'All splits',
  train: 'Train',
  validation: 'Validation',
  test: 'Test',
}

export function formatSplit(split: DatasetSplit): string {
  return splitLabels[split]
}

export function formatDimensions(width: number, height: number): string {
  return `${width} × ${height}`
}

export function formatFileDescription(mimeType: string, fileSize: number): string {
  return `${mimeType} · ${(fileSize / 1000).toLocaleString(undefined, {
    maximumFractionDigits: 1,
  })} KB`
}

/** What to do about a failed request: prepare the data, or start the API. */
export function formatRecoveryHint(unprepared: boolean): string {
  return unprepared
    ? 'Run npm run prepare:data to prepare the local data, then try again.'
    : 'Make sure the local API is running, then try again.'
}

export function formatSimilarity(value: number): string {
  return value.toFixed(3)
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.'
}
