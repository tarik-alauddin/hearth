import { Wordmark } from './Wordmark';

/** The app shell. For now, the front door; the landing scene, sign-in and servers follow (M10). */
export function App() {
  return (
    <main className="wrap" style={{ paddingBlock: '64px', display: 'grid', gap: '20px', maxWidth: '720px' }}>
      <Wordmark />
      <h1 style={{ font: '700 var(--step-3)/1.04 var(--font-display)', margin: 0 }}>
        Game servers for your group. <span style={{ color: 'var(--glow)' }}>Pay only when you play.</span>
      </h1>
      <p style={{ margin: 0, color: 'var(--ash)', fontSize: 'var(--step-1)' }}>
        Bring your world, invite your friends, and only pay for the time you actually play.
      </p>
    </main>
  );
}
