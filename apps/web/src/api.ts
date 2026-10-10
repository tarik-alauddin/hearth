import type { WebConfig } from '@hearth/shared';

/** The API refused a request: its status and message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Api {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
}

/**
 * Calls the API with the signed-in user's ID token. A 401 (the token expired early, or was
 * revoked) refreshes it once and tries again; a second 401, or no session, signs the person out.
 */
export function apiClient(opts: {
  config: WebConfig;
  /** The ID token; `force` refreshes it first. Undefined when signed out. */
  idToken: (force: boolean) => Promise<string | undefined>;
  signedOut: () => void;
  fetch?: typeof fetch;
}): Api {
  const doFetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    for (const force of [false, true]) {
      const token = await opts.idToken(force);
      if (!token) break;
      const res = await doFetch(`${opts.config.apiUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
        ...(payload ? { body: payload } : {}),
      });
      if (res.status === 401) continue;
      return readResponse<T>(res);
    }
    opts.signedOut();
    throw new ApiError(401, 'You are signed out. Please sign in again.');
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    patch: (path, body) => request('PATCH', path, body),
    delete: (path) => request('DELETE', path),
  };
}

/** The body of a 2xx answer, or an ApiError with the API's message. */
async function readResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? text;
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, message || `Request failed (${res.status})`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}
