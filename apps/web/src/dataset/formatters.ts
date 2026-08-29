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
  return `${mimeType} · ${(fileSize / 1024).toLocaleString(undefined, {
    maximumFractionDigits: 1,
  })} KB`
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.'
}
