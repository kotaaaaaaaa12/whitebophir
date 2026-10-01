// Optional settings supplied through the Cloudflare dashboard or Wrangler.
// Resource bindings are generated from wrangler.jsonc in worker-configuration.d.ts.
interface Env {
  AUTH_SECRET_KEY?: string;
  WBO_BOARD_MODERATORS?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
}
