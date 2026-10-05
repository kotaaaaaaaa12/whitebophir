import { Container } from '@cloudflare/containers';
import en from '../app/src/lib/i18n/en.json';
import ja from '../app/src/lib/i18n/ja.json';

export class BeatbumpContainer extends Container {
  defaultPort = 8080;
  sleepAfter = '10m';
  enableInternet = true;
  constructor(ctx, env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      let key = await ctx.storage.get('companion-key');
      if (!key) {
        key = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
        await ctx.storage.put('companion-key', key);
      }
      this.envVars = { SERVER_SECRET_KEY: key, MEDIA_PROXY_KEY: key };
    });
  }
  async fetch(request) {
    await this.ready;
    return super.fetch(request);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Companion is private; only validated media tickets are public.
    if (url.pathname === '/companion' || url.pathname.startsWith('/companion/')) {
      return new Response('Not found', { status: 404 });
    }
    if (!['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS'].includes(request.method)) {
      return new Response('Method not allowed', { status: 405 });
    }
    if (['POST', 'DELETE'].includes(request.method)) {
      const origin = request.headers.get('Origin');
      if ((origin && origin !== url.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
        return new Response('Origin not allowed', { status: 403 });
      }
    }
    const headers = new Headers(request.headers);
    headers.set('X-Beatbump-Origin', url.origin);
    headers.delete('X-Forwarded-Host');
    headers.delete('X-Forwarded-Proto');
    headers.delete('cf-container-target-port');
    const container = env.BEATBUMP.get(env.BEATBUMP.idFromName('beatbump-shared-v1'), { locationHint: 'apac' });
    try {
      const response = await container.fetch(new Request(request, { headers }));
      const outgoing = new Headers(response.headers);
      outgoing.set('X-Content-Type-Options', 'nosniff');
      if ((url.pathname.startsWith('/api/') && url.pathname !== '/api/v1/image') || outgoing.get('Content-Type')?.includes('text/html')) {
        outgoing.set('Cache-Control', 'no-store');
      }
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outgoing });
    } catch (error) {
      console.error('Beatbump container unavailable:', error?.message || String(error));
      const headers = { 'Cache-Control': 'no-store', 'Retry-After': '10' };
      if (request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
        return Response.json({ error: 'Beatbump is starting or temporarily unavailable. Please try again.' }, { status: 503, headers });
      }
      return new Response(startingPage(request), { status: 503, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
    }
  }
};

function startingPage(request) {
  const choice = request.headers.get('Cookie')?.match(/(?:^|;\s*)beatbump-language=(auto|ja|en)(?:;|$)/)?.[1] || 'auto';
  const language = choice === 'auto' ? (/^ja(?:-|[,;]|$)/i.test(request.headers.get('Accept-Language') || '') ? 'ja' : 'en') : choice;
  const catalog = language === 'ja' ? ja : en;
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  return STARTING_PAGE.replace('lang="en"', 'lang="' + language + '"').replaceAll('Beatbump is starting</', escape(catalog['Beatbump is starting']) + '</')
    .replace('The music server is starting or being provisioned. This page checks readiness automatically. The first deployment can take several minutes.', escape(catalog['The music server is starting or being provisioned. This page checks readiness automatically. The first deployment can take several minutes.']))
    .replace('Retry now</', escape(catalog['Retry now']) + '</');
}
const startupKeys = ['Beatbump is starting', 'The music server is starting or being provisioned. This page checks readiness automatically. The first deployment can take several minutes.', 'Retry now'];
const startupCatalogs = Object.fromEntries(Object.entries({ en, ja }).map(([locale, catalog]) => [locale, startupKeys.map(key => catalog[key])]));
const STARTING_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="10"><title>Beatbump is starting</title><style>:root{color-scheme:dark light}body{font:16px system-ui;margin:0;min-height:100dvh;display:grid;place-items:center;background:light-dark(#f7f7fa,#101014);color:light-dark(#18181c,#eee)}main{max-width:32rem;padding:2rem}h1{font-size:1.6rem}p{line-height:1.6;color:light-dark(#555,#bbb)}a{color:#bd79ff}</style><main><h1>Beatbump is starting</h1><p>The music server is starting or being provisioned. This page checks readiness automatically. The first deployment can take several minutes.</p><a href="">Retry now</a></main><script>
(() => {
  // Recover the device preference even if cookies are unavailable.
  let choice = 'auto';
  try { choice = localStorage.getItem('beatbump-language') || 'auto'; } catch {}
  const firstLanguage = navigator.languages?.[0] || navigator.language || 'en';
  const language = choice === 'ja' || choice === 'en' ? choice : (/^ja(?:-|$)/i.test(firstLanguage) ? 'ja' : 'en');
  const strings = ${JSON.stringify(startupCatalogs)}[language];
  document.documentElement.lang = language;
  document.title = strings[0];
  document.querySelector('h1').textContent = strings[0];
  document.querySelector('main p').textContent = strings[1];
  document.querySelector('main a').textContent = strings[2];
  let attempts = 0;
  async function checkReady() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch('/healthz', { cache: 'no-store', signal: controller.signal });
      if (response.ok && (await response.json()).status === 'ready') {
        location.reload();
        return;
      }
    } catch {
      // The page refresh remains a fallback if readiness cannot be checked.
    } finally {
      clearTimeout(timeout);
    }
    if (++attempts < 30) setTimeout(checkReady, 1000);
  }
  void checkReady();
})();
</script></html>`;
