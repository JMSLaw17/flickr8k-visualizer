import { useEffect, useState } from 'react'

interface DatasetImageProps {
  src: string
  alt: string
  className: string
  eager?: boolean
  width?: number
  height?: number
}

function DatasetImage({
  src,
  alt,
  className,
  eager = false,
  width,
  height,
}: DatasetImageProps) {
  const [failed, setFailed] = useState(false)
  const displaySize = width && height ? { width, height } : undefined

  useEffect(() => setFailed(false), [src])

  if (failed) {
    return (
      <div
        className={`${className} image-fallback`}
        role="img"
        aria-label={alt}
        style={displaySize}
      >
        <span>Image unavailable</span>
      </div>
    )
  }

  return (
    <img
      className={className}
      src={src}
      alt={alt}
      width={width}
      height={height}
      style={displaySize}
      loading={eager ? 'eager' : 'lazy'}
      onError={() => setFailed(true)}
    />
  )
}

export default DatasetImage
