import { describe, expect, it } from 'vitest';
import { callerFromClaims } from './claims.js';

const SUB = '98f1b370-6031-706d-6544-5f408b08fe07';

describe('callerFromClaims', () => {
  it('reads a Google user: their profile, and a plain user actor', () => {
    expect(
      callerFromClaims({
        sub: SUB,
        token_use: 'id',
        'cognito:username': 'Google_1234567890',
        email: 'tarik@example.com',
        name: 'Tarik',
        picture: 'https://lh3.example/a.png',
      }),
    ).toEqual({
      userId: SUB,
      admin: false,
      actor: { kind: 'user', userId: SUB },
      profile: { provider: 'Google', email: 'tarik@example.com', name: 'Tarik', picture: 'https://lh3.example/a.png' },
    });
  });

  it("reads a Discord user's username and display name", () => {
    const caller = callerFromClaims({
      sub: SUB,
      token_use: 'id',
      'cognito:username': 'Discord_5678',
      preferred_username: 'tarik',
      nickname: 'Tarik A',
    });
    expect(caller?.profile).toEqual({ provider: 'Discord', username: 'tarik', displayName: 'Tarik A' });
  });

  it('names a password user Cognito (their username is their sub)', () => {
    expect(callerFromClaims({ sub: SUB, token_use: 'id', 'cognito:username': SUB })?.profile.provider).toBe('Cognito');
  });

  it("makes the admin group's members admin actors, however API Gateway passes the groups", () => {
    for (const groups of [['admin'], '[admin]', '[other admin]', '[other, admin]']) {
      expect(callerFromClaims({ sub: SUB, token_use: 'id', 'cognito:groups': groups })?.actor).toEqual({ kind: 'admin', id: SUB });
    }
    expect(callerFromClaims({ sub: SUB, token_use: 'id', 'cognito:groups': '[administrators]' })?.admin).toBe(false);
  });

  it('refuses access tokens (no profile) and tokens without a subject', () => {
    expect(callerFromClaims({ sub: SUB, token_use: 'access' })).toBeUndefined();
    expect(callerFromClaims({ token_use: 'id' })).toBeUndefined();
    expect(callerFromClaims(undefined)).toBeUndefined();
  });
});
