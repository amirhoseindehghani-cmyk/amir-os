import { AUTH_COOKIE, authCookieOptions, safeNextPath } from '@/lib/auth';

// FormData entries can be files; only plain text fields are meaningful here.
function field(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A form POST (rather than a ?password= link) is what makes sign-in work in an
// iOS home-screen app, which keeps a cookie jar separate from Safari's.
export async function POST(request: Request) {
  const expected = process.env.APP_PASSWORD;
  const form = await request.formData();
  const supplied = field(form, 'password');
  const next = safeNextPath(field(form, 'next'));

  if (!expected || supplied !== expected) {
    const retry = new URL('/login', request.url);
    retry.searchParams.set('error', '1');
    if (next !== '/') retry.searchParams.set('next', next);
    return Response.redirect(retry, 303);
  }

  const response = new Response(null, { status: 303, headers: { Location: new URL(next, request.url).toString() } });
  const options = authCookieOptions();
  response.headers.append(
    'Set-Cookie',
    `${AUTH_COOKIE}=${encodeURIComponent(expected)}; Path=${options.path}; Max-Age=${options.maxAge}; HttpOnly; SameSite=Lax${options.secure ? '; Secure' : ''}`,
  );
  return response;
}

export async function DELETE(request: Request) {
  const options = authCookieOptions();
  const response = new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  response.headers.append(
    'Set-Cookie',
    `${AUTH_COOKIE}=; Path=${options.path}; Max-Age=0; HttpOnly; SameSite=Lax${options.secure ? '; Secure' : ''}`,
  );
  return response;
}
