import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@smithy/signature-v4';
import type { AwsCredentialIdentityProvider } from '@smithy/types';

/** A non-2xx answer from the API, with its message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Api {
  get<T>(path: string, query?: Record<string, string | undefined>): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

/** Calls the Hearth API, signing each request with your AWS credentials (IAM auth). */
export function apiClient(opts: {
  baseUrl: string;
  region: string;
  credentials: AwsCredentialIdentityProvider;
  fetch?: typeof globalThis.fetch;
}): Api {
  const url = new URL(opts.baseUrl);
  const signer = new SignatureV4({ service: 'execute-api', region: opts.region, credentials: opts.credentials, sha256: Sha256 });
  const doFetch = opts.fetch ?? globalThis.fetch;

  async function request<T>(method: string, path: string, query: Record<string, string> = {}, body?: unknown): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const signed = await signer.sign({
      method,
      protocol: url.protocol,
      hostname: url.hostname,
      path,
      query,
      headers: { host: url.host, ...(payload ? { 'content-type': 'application/json' } : {}) },
      ...(payload ? { body: payload } : {}),
    });
    const qs = new URLSearchParams(query).toString();
    const res = await doFetch(`${url.origin}${path}${qs ? `?${qs}` : ''}`, {
      method,
      headers: signed.headers,
      ...(payload ? { body: payload } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        // not JSON
      }
      throw new ApiError(res.status, message || res.statusText);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    get: (path, query = {}) =>
      request('GET', path, Object.fromEntries(Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined))),
    post: (path, body) => request('POST', path, {}, body),
  };
}

/** The API endpoint: HEARTH_API_URL, or the SSM parameter ApiStack publishes for the environment. */
export async function findApiUrl(env: string, region: string): Promise<string> {
  if (process.env.HEARTH_API_URL) return process.env.HEARTH_API_URL;
  const out = await new SSMClient({ region }).send(new GetParameterCommand({ Name: `/hearth/${env}/api-url` }));
  const value = out.Parameter?.Value;
  if (!value) throw new Error(`No /hearth/${env}/api-url parameter in ${region}`);
  return value;
}
