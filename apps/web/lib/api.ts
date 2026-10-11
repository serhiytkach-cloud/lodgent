import 'server-only';
import { redirect } from 'next/navigation';
import { webEnv } from './env';
import { getSessionToken } from './session';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }

  /** Field-level messages from a 400 validation error, keyed by the last path segment. */
  fieldErrors(): Record<string, string> {
    const issues = (this.details?.issues ?? []) as { path: string; message: string }[];
    return Object.fromEntries(issues.map((i) => [i.path.split('.').at(-1) ?? i.path, i.message]));
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Defaults to the signed-in user's session token. Pass null for anonymous calls. */
  token?: string | null;
  /** Redirect to sign-in on 401 (pages). Server Actions usually want the error instead. */
  redirectOnUnauthorized?: boolean;
}

/** Calls the API from the server (Server Components, Server Actions, Route Handlers). */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = options.token === undefined ? await getSessionToken() : options.token;
  const res = await fetch(`${webEnv().apiUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      accept: 'application/json',
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    cache: 'no-store',
  });

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const error = (
      json as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null
    )?.error;
    if (res.status === 401 && (options.redirectOnUnauthorized ?? true)) {
      redirect('/login?expired=1');
    }
    throw new ApiError(
      res.status,
      error?.code ?? 'error',
      error?.message ?? `Request failed (${res.status})`,
      error?.details,
    );
  }
  return json as T;
}

/** Standard result shape for Server Actions used with `useActionState`. */
export type ActionState = {
  ok?: boolean;
  message?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
} | null;

export function actionError(error: unknown): ActionState {
  if (error instanceof ApiError) {
    return { error: error.message, fieldErrors: error.status === 400 ? error.fieldErrors() : undefined };
  }
  // Let Next.js handle redirect()/notFound() control-flow errors.
  throw error;
}
