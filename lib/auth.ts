export const AUTH_COOKIE = 'auth';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 90;

export function authCookieOptions() {
  return {
    httpOnly: true,
    // http://localhost has no TLS, so only mark the cookie Secure in production.
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  };
}

// Only same-origin absolute paths may be used as a post-login destination.
export function safeNextPath(value: string | null | undefined) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}
