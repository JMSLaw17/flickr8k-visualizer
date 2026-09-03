import { formatRecoveryHint } from '../dataset/formatters'

interface ErrorCardProps {
  title: string
  message: string
  /** Whether the failure means the local data is not prepared yet. */
  unprepared: boolean
  onRetry: () => void
}

/** A failed request, with what to do about it and a way to try again. */
function ErrorCard({ title, message, unprepared, onRetry }: ErrorCardProps) {
  return (
    <div className="state-card" role="alert">
      <span className="state-card__mark">!</span>
      <h3>{title}</h3>
      <p>{message}</p>
      <p className="state-card__hint">{formatRecoveryHint(unprepared)}</p>
      <button className="button button--primary" type="button" onClick={onRetry}>
        Try again
      </button>
    </div>
  )
}

export default ErrorCard
