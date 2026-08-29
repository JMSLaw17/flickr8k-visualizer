function GallerySkeleton() {
  return (
    <div className="gallery-grid" aria-hidden="true">
      {Array.from({ length: 12 }, (_, index) => (
        <div className="sample-skeleton" key={index}>
          <div className="sample-skeleton__image" />
          <div className="sample-skeleton__line sample-skeleton__line--wide" />
          <div className="sample-skeleton__line" />
        </div>
      ))}
    </div>
  )
}

export default GallerySkeleton
