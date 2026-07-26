const baseUrl = process.env.BATTLECITY_API_SMOKE_URL || 'http://127.0.0.1:3001';
const publicOrigin = new URL(
  process.env.BATTLECITY_PUBLIC_ORIGIN || 'https://localhost:8080',
);
const response = await fetch(`${baseUrl}/api/auth/google/start`, {
  redirect: 'manual',
  headers: {
    'x-forwarded-host': publicOrigin.host,
    'x-forwarded-proto': publicOrigin.protocol.replace(':', ''),
  },
});

if (response.status !== 302) {
  throw new Error(`Google login start returned ${response.status}`);
}

const location = response.headers.get('location');
if (location === null) {
  throw new Error('Google login start did not return a redirect');
}

const authorizationUrl = new URL(location);
const redirectUri = authorizationUrl.searchParams.get('redirect_uri');
const state = authorizationUrl.searchParams.get('state');

if (
  authorizationUrl.origin !== 'https://accounts.google.com' ||
  redirectUri === null ||
  state === null ||
  state.split('.').length !== 2
) {
  throw new Error('Google login redirect is malformed');
}

console.log(
  JSON.stringify(
    {
      ok: true,
      authorizationHost: authorizationUrl.host,
      redirectUri,
      scope: authorizationUrl.searchParams.get('scope'),
      signedState: true,
    },
    null,
    2,
  ),
);
