type BrandMarkProps = {
  compact?: boolean;
};

export function BrandMark({ compact = false }: BrandMarkProps) {
  return (
    <span className="brand-mark" role="img" aria-label="Astra3D">
      <svg
        className="brand-mark__symbol"
        viewBox="0 0 42 42"
        aria-hidden="true"
      >
        <path
          d="M21 3.5 38.5 34H30l-3.2-5.8H15.1L12 34H3.5L21 3.5Z"
          fill="currentColor"
        />
        <path
          d="m21 12.2 5.3 9.4H15.7l5.3-9.4Z"
          fill="var(--color-cyan)"
        />
        <path
          d="m21 18.2 3.8 6.7L21 31.6l-3.8-6.7 3.8-6.7Z"
          fill="var(--color-surface-0)"
        />
      </svg>
      {!compact && (
        <span className="brand-mark__word">
          Astra<span>3D</span>
        </span>
      )}
    </span>
  );
}
