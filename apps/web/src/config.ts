import type { WebConfig } from '@hearth/shared';

/**
 * The environment's settings (the API, the sign-in client), read at runtime from `/config.json`:
 * WebContentStack writes it on deploy; `pnpm --filter @hearth/web dev` serves `config.local.json`
 * (`scripts/web-dev-config.ps1` writes it). One build serves every environment.
 */
export async function loadConfig(doFetch: typeof fetch = fetch): Promise<WebConfig> {
  const res = await doFetch('/config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`No config.json (${res.status})`);
  return (await res.json()) as WebConfig;
}
