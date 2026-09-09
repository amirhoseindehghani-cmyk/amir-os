import { NextResponse, type NextRequest } from 'next/server';
import { AUTH_COOKIE, authCookieOptions, safeNextPath } from '@/lib/auth';

// Anything the browser must be able to reach while signed out.
function isPublicPath(pathname: string) {
  return pathname === '/login' || pathname === '/api/login' || pathname === '/manifest.webmanifest';
}

function presentedPassword(request: NextRequest) {
  const header = request.headers.get('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return request.headers.get('x-app-password') ?? undefined;
}

export function middleware(request: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next(); // no password set = open

  const { pathname, searchParams } = request.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  if (request.cookies.get(AUTH_COOKIE)?.value === password) return NextResponse.next();

  // Non-browser clients (scripts, shortcuts) can authenticate per-request.
  if (presentedPassword(request) === password) return NextResponse.next();

  // Legacy link login: ?password=... sets the cookie and drops the secret from the URL.
  // Keep the original path so deep links and home-screen shortcuts survive the redirect.
  if (searchParams.get('password') === password) {
    const destination = request.nextUrl.clone();
    destination.searchParams.delete('password');
    const response = NextResponse.redirect(destination);
    response.cookies.set(AUTH_COOKIE, password, authCookieOptions());
    return response;
  }

  // API calls need a machine-readable body: the client distinguishes "signed out"
  // from "storage is down" so it never silently degrades to a local-only cache.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Your session has expired. Sign in again to keep saving to the cloud.',
          retryable: false,
        },
      },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // A form-based page beats a 401 wall: iOS home-screen apps keep their own cookie
  // jar, so they must be able to sign in without re-typing a ?password= URL.
  const login = new URL('/login', request.url);
  const next = safeNextPath(`${pathname}${request.nextUrl.search}`);
  if (next !== '/') login.searchParams.set('next', next);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.svg).*)'],
};
