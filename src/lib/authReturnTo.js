// Where to send the user after logging in. Only same-origin paths are
// accepted, so a crafted ?returnTo= cannot bounce users to another site.
export function safeReturnTo(fallback = '/') {
  if (typeof window === 'undefined') return fallback;
  const raw = new URLSearchParams(window.location.search).get('returnTo');
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}
