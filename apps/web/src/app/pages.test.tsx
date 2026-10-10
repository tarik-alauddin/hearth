import type { MeResponse } from '@hearth/shared';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { CallbackView } from './Callback';
import { HomeView } from './Home';
import { Shell } from './Shell';

const me: MeResponse = {
  userId: 'u1',
  admin: false,
  approved: false,
  serverLimit: 3,
  createdAt: '2026-10-10T00:00:00Z',
  displayName: 'Ash',
  picture: 'https://cdn.discordapp.com/avatars/1/a.png',
};

describe('the app pages', () => {
  it('tells someone not yet approved that they are waiting, without technical detail', () => {
    const html = renderToString(<HomeView me={me} />);
    expect(html).toContain('Welcome, Ash');
    expect(html).toContain('Waiting for approval');
    expect(html).not.toMatch(/Cognito|admin group|token/i);
  });

  it('skips the wait for approved people and admins', () => {
    expect(renderToString(<HomeView me={{ ...me, approved: true }} />)).not.toContain('Waiting for approval');
    expect(renderToString(<HomeView me={{ ...me, admin: true }} />)).not.toContain('Waiting for approval');
  });

  it('shows who is signed in, with their picture or initial', () => {
    const withPicture = renderToString(<Shell me={me} onSignOut={() => undefined}>x</Shell>);
    expect(withPicture).toContain('src="https://cdn.discordapp.com/avatars/1/a.png"');
    expect(withPicture).toContain('Sign out');
    const noPicture = { ...me, picture: undefined, displayName: undefined, email: 'zed@example.com' };
    const initial = renderToString(<Shell me={noPicture} onSignOut={() => undefined}>x</Shell>);
    expect(initial).toContain('>Z</span>');
    expect(initial).toContain('zed');
  });

  it('offers to sign in again when the callback fails', () => {
    expect(renderToString(<CallbackView error="" onRetry={() => undefined} />)).toContain('Signing you in');
    const failed = renderToString(<CallbackView error="Sign-in was cancelled." onRetry={() => undefined} />);
    expect(failed).toContain('Sign-in was cancelled.');
    expect(failed).toContain('Sign in again');
  });

  it('routes the callback and the signed-in pages (loading until config.json is read)', () => {
    expect(renderToString(<App path="/auth/callback" />)).toContain('Signing you in');
    expect(renderToString(<App path="/app" />)).toContain('Loading…');
    expect(renderToString(<App path="/" />)).toContain('Pay only when you play.');
  });
});
