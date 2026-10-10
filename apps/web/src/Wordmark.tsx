/** Hearth's wordmark: an ember block and the name in pixel type (the only pixel type we use). */
export function Wordmark() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', font: '700 var(--step-1)/1 var(--font-wordmark)', letterSpacing: '0.02em' }}>
      <span aria-hidden="true" style={{ width: '14px', height: '14px', background: 'var(--ember)', boxShadow: '0 0 14px var(--ember)' }} />
      Hearth
    </div>
  );
}
