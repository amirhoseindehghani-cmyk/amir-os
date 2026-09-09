import { NextResponse, type NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next(); // no password set = open

  if (request.nextUrl.pathname === '/login') return NextResponse.next();

  const cookie = request.cookies.get('auth')?.value;
  if (cookie === password) return NextResponse.next();

  // Simple login: ?password=... sets the cookie and drops the secret from the URL.
  const param = request.nextUrl.searchParams.get('password');
  if (param === password) {
    const response = NextResponse.redirect(new URL('/', request.url));
    response.cookies.set('auth', password, {
      httpOnly: true,
      // http://localhost has no TLS, so only mark the cookie Secure in production.
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 90,
    });
    return response;
  }

  return new NextResponse('Unauthorized. Add ?password=yourpassword to the URL to log in.', {
    status: 401,
  });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.svg).*)'],
};
