export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;

  return (
    <main className="login-shell">
      <form className="login-card" action="/api/login" method="post">
        <div className="brandmark">A</div>
        <h1>Amir OS</h1>
        <p>Sign in once on this device. The session lasts 90 days.</p>
        {error && <div className="login-error" role="alert">That password did not match. Try again.</div>}
        <input type="hidden" name="next" value={next ?? '/'} />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
