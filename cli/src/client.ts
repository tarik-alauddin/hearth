import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { fleetCheckFunctionName, type CreateUploadResponse, type FleetReport } from '@hearth/shared';

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
  patch<T>(path: string, body: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
}

/** Calls the Hearth API as the signed-in user (`hearth login`), with their ID token. */
export function userApiClient(opts: { baseUrl: string; idToken: () => Promise<string>; fetch?: typeof globalThis.fetch }): Api {
  const url = new URL(opts.baseUrl);
  const doFetch = opts.fetch ?? globalThis.fetch;

  async function request<T>(method: string, path: string, query: Record<string, string> = {}, body?: unknown): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const qs = new URLSearchParams(query).toString();
    const res = await doFetch(`${url.origin}${path}${qs ? `?${qs}` : ''}`, {
      method,
      headers: { authorization: `Bearer ${await opts.idToken()}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
      ...(payload ? { body: payload } : {}),
    });
    return readResponse<T>(res);
  }

  return {
    get: (path, query = {}) => request('GET', path, definedOnly(query)),
    post: (path, body) => request('POST', path, {}, body),
    patch: (path, body) => request('PATCH', path, {}, body),
    delete: (path) => request('DELETE', path),
  };
}

function definedOnly(query: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined));
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
    throw new ApiError(res.status, message || res.statusText);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * Sends a file with a presigned S3 POST form (from `POST /v1/uploads`): every form field, then
 * the file last, as S3 requires. The file streams from disk. S3 refuses anything over the form's
 * size cap; its XML error becomes the message.
 */
export async function sendUpload(
  form: Pick<CreateUploadResponse, 'url' | 'fields'>,
  file: string,
  doFetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> {
  const body = new FormData();
  for (const [name, value] of Object.entries(form.fields)) body.append(name, value);
  body.append('file', await openAsBlob(file), basename(file));
  const res = await doFetch(form.url, { method: 'POST', body });
  if (!res.ok) {
    const xml = await res.text();
    const message = /<Message>([^<]*)<\/Message>/.exec(xml)?.[1] ?? (xml || res.statusText);
    throw new Error(`The upload failed: ${message}`);
  }
}

/** Runs the environment's fleet check Lambda (directly, not through the API) and returns its report. */
export async function invokeFleetCheck(env: string, region: string): Promise<FleetReport> {
  const out = await new LambdaClient({ region }).send(new InvokeCommand({ FunctionName: fleetCheckFunctionName(env) }));
  const body = new TextDecoder().decode(out.Payload);
  if (out.FunctionError) throw new Error(`The fleet check failed: ${body}`);
  return JSON.parse(body) as FleetReport;
}

/** The API endpoint: HEARTH_API_URL, or the SSM parameter ApiStack publishes for the environment. */
export async function findApiUrl(env: string, region: string): Promise<string> {
  if (process.env.HEARTH_API_URL) return process.env.HEARTH_API_URL;
  const out = await new SSMClient({ region }).send(new GetParameterCommand({ Name: `/hearth/${env}/api-url` }));
  const value = out.Parameter?.Value;
  if (!value) throw new Error(`No /hearth/${env}/api-url parameter in ${region}`);
  return value;
}
