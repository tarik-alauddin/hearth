import { lazy, Suspense, useState } from 'react';
import { Wordmark } from '../Wordmark';
import './landing.css';

// three.js is large: the scene loads as its own bundle, after the text is on screen.
const HeroScene = lazy(() => import('./HeroScene'));

/** The tallest bar in the example week, in px (a percentage has no height to resolve against). */
const BAR_MAX_PX = 120;

/** An example week for the pay-for-play promise: the nights a group plays (0–100). */
const WEEK = [
  { day: 'Mon', play: 0 },
  { day: 'Tue', play: 46 },
  { day: 'Wed', play: 0 },
  { day: 'Thu', play: 0 },
  { day: 'Fri', play: 70 },
  { day: 'Sat', play: 90 },
  { day: 'Sun', play: 0 },
];

/** The front door: the hearth scene, the pay-for-play promise, how it works. */
export function Landing() {
  const [note, setNote] = useState('');
  const soon = () => setNote('Sign-in opens soon.');

  return (
    <>
      <header className="hero">
        <div className="scene" aria-hidden="true">
          <Suspense fallback={null}>
            <HeroScene />
          </Suspense>
        </div>
        <div className="wrap">
          <div className="hero-inner">
            <div className="hero-copy">
              <Wordmark />
              <h1>
                Game servers for your group. <em>Pay only when you play.</em>
              </h1>
              <p>Bring your world, invite your friends, and only pay for the time you actually play.</p>
              <div className="actions">
                <button className="btn btn-primary" type="button" onClick={soon}>Sign in</button>
                <button className="btn" type="button" onClick={soon}>Got an invite?</button>
              </div>
              <p className="note" aria-live="polite">{note}</p>
            </div>
          </div>
          <p className="caption"><b>Minecraft today.</b> More islands join the hearth as more games arrive.</p>
        </div>
      </header>

      <main>
        <section className="band">
          <div className="wrap">
            <div className="promise">
              <div>
                <h2>Pay for the evenings you <em>play.</em></h2>
                <p>No paying all month for an empty world. With Hearth, the nights you play are the nights you pay for.</p>
              </div>
              <div className="week" role="img" aria-label="An example week: you pay for the three evenings your group plays, and nothing for the rest">
                {WEEK.map(({ day, play }) => (
                  <div key={day}>
                    <span className={play ? 'on' : undefined} style={{ height: `${Math.round(((play || 8) / 100) * BAR_MAX_PX)}px` }} />
                    <small>{day}</small>
                  </div>
                ))}
                <p className="week-legend"><i />The nights you play, and the only ones you pay for.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="band">
          <div className="wrap">
            <h2>How it works</h2>
            <ol className="steps">
              <li><h3>Start a server</h3><p>Begin a fresh world, or bring the one your group already plays.</p></li>
              <li><h3>Invite your friends</h3><p>Send them an invite. They can start the server whenever they want to play.</p></li>
              <li><h3>Play</h3><p>Jump in whenever you like, and pick up where you left off next time.</p></li>
            </ol>
          </div>
        </section>

        <section className="band">
          <div className="wrap">
            <h2>Everything else you'd want</h2>
            <div className="feats">
              <div><h3>Frequent backups</h3><p>Your world is backed up as you go. Roll back if something goes wrong.</p></div>
              <div><h3>Easy upgrades</h3><p>Move to a new game version when your group is ready.</p></div>
              <div><h3>Friends, not passwords</h3><p>Invite people to your server and choose what they can do.</p></div>
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="wrap">
          <p>Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.</p>
        </div>
      </footer>
    </>
  );
}
