/**
 * Which web pages may call this service with the user's session. The web
 * app is served from the same host as the API (gateway, ingress), so the
 * same origin is always allowed; ALLOWED_ORIGINS (comma separated) adds
 * others. Requests without an Origin (mobile app, server to server) carry
 * no browser session to abuse and are allowed.
 */
export function allowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

export function isAllowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  if (allowedOrigins().includes(origin)) return true;
  try {
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}
