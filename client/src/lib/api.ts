import { restoreAppSession } from './app-session';

// Empty string means "same origin" - the API and this UI are served by one
// process on one port, so "/api/..." resolves against whatever host the browser
// is already on. That removes the class of bug where NEXT_PUBLIC_API_URL is
// baked into the build pointing at the wrong host (or missing its scheme) and
// every request 404s.
//
// ?? not || on purpose: an explicitly empty NEXT_PUBLIC_API_URL must stay
// empty. Only an UNSET variable falls back, and only in development, where the
// API runs on its own port beside `next dev`.
const API_URL =
  process.env.NEXT_PUBLIC_API_URL ??
  (process.env.NODE_ENV === 'development' ? 'http://localhost:4000' : '');

/** Keep a renewed login when the server sends one - it does when the stored one is half used. */
function keepRenewedToken(res: Response) {
  const fresh = res.headers.get('x-new-token');
  if (!fresh) return;
  try {
    localStorage.setItem('token', fresh);
  } catch {
    // Storage blocked: the current login still works until it ends.
  }
}

/**
 * The login is gone or refused and nothing could renew it: clear it and go to
 * the sign-in page, instead of leaving a screen full of "No token provided".
 */
function signedOut(hadToken: boolean) {
  // No login was ever stored (a public page, or the sign-in page): nothing ended.
  if (typeof window === 'undefined' || !hadToken) return;
  try {
    localStorage.removeItem('token');
  } catch {
    // Nothing to clear.
  }
  if (window.location.pathname !== '/login') window.location.assign('/login');
}

export async function api<T>(path: string, options: RequestInit = {}, retried = false): Promise<T> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  // Inside the Android app, a refused login is renewed by the app and the
  // request tried once more, rather than the caller being signed out.
  if (res.status === 401 && !retried && !path.startsWith('/api/auth/login') && (await restoreAppSession())) {
    return api<T>(path, options, true);
  }

  keepRenewedToken(res);

  // A refused login on anything but the sign-in itself: the session has ended.
  if (res.status === 401 && !path.startsWith('/api/auth/login')) {
    // The check of who is signed in (auth-context) handles its own refusal.
    if (!path.startsWith('/api/auth/me')) signedOut(!!token);
    throw Object.assign(new Error('Your session has ended. Please sign in again.'), { status: 401 });
  }

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Request failed' }));
    // The status rides along for the few callers that act on it (a 409 from
    // the laptop dialer means "your phone is not ready", not "it broke").
    throw Object.assign(new Error(error.error || 'Request failed'), { status: res.status, code: error.code as string | undefined, data: error });
  }

  return res.json();
}

/**
 * Was this rejection a cancelled request rather than a failure?
 *
 * A component that aborts its own fetch on unmount or on a new keystroke gets
 * a rejected promise for a request it deliberately threw away. Rendering that
 * as "Could not load this list" puts an error on screen for working software -
 * which is worse than the stale data the abort was there to prevent.
 */
export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

export const apiClient = {
  get: <T>(path: string, init?: RequestInit) => api<T>(path, init),
  post: <T>(path: string, body: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => api<T>(path, { method: 'DELETE' }),
  // For binary responses (PDF receipts) that a plain <a href> can't carry an
  // Authorization header for - fetches the file as a Blob so the caller can
  // open it in a new tab via URL.createObjectURL.
  getBlob: async (path: string, init?: RequestInit): Promise<Blob> => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    const res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    keepRenewedToken(res);
    if (res.status === 401) {
      signedOut(!!token);
      throw new Error('Your session has ended. Please sign in again.');
    }
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || 'Request failed');
    }
    return res.blob();
  },
};
