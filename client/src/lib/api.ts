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

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
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
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || 'Request failed');
    }
    return res.blob();
  },
};
