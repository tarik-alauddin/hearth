import type { ReactNode } from 'react';
import type { MeResponse } from '@hearth/shared';
import { Wordmark } from '../Wordmark';
import { Avatar } from './Avatar';
import './app.css';

/** The app pages' frame: the wordmark, who's signed in, and the page. Tidy, unlike the landing. */
export function Shell({ me, onSignOut, children }: { me?: MeResponse; onSignOut?: () => void; children: ReactNode }) {
  return (
    <div className="shell">
      <header className="topbar">
        <div className="wrap topbar-inner">
          <a href="/app" className="home-link" aria-label="Hearth: your servers"><Wordmark /></a>
          {me && onSignOut && (
            <div className="who">
              <Avatar me={me} />
              <span className="who-name">{displayName(me)}</span>
              <button className="btn btn-small" type="button" onClick={onSignOut}>Sign out</button>
            </div>
          )}
        </div>
      </header>
      <main className="wrap page">{children}</main>
    </div>
  );
}

/** The name to show: Discord's display name or username, Google's name, else the email's name. */
export function displayName(me: MeResponse): string {
  return me.displayName ?? me.name ?? me.username ?? me.email?.split('@')[0] ?? 'You';
}
