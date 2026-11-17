/* global fetch, URL, Headers */
// This project's upstream-operator live test (README.md, The upstream-operator and Cloudflare for SaaS setups), not for
// deployers: a publisher on Cloudflare, forwarding /_sid/* to the upstream operator's Worker with
// docs/upstream-operators.md's Cloudflare recipe, as written there except that the endpoint's origin is the SID_ENDPOINT
// var instead of a literal.
// SID_UPSTREAM_SECRET is a Worker secret.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set('x-sid-upstream-auth', env.SID_UPSTREAM_SECRET);
    headers.set('x-forwarded-host', url.hostname);
    // CF-Connecting-IP and request.cf are Cloudflare's own; never X-Forwarded-For.
    headers.set('x-sid-client-ip', request.headers.get('cf-connecting-ip') ?? '');
    for (const [name, value] of [['x-sid-country', request.cf?.country], ['x-sid-region', request.cf?.regionCode]]) {
      if (typeof value === 'string' && value !== '') headers.set(name, value); else headers.delete(name);
    }
    const upstream = new URL(url.pathname + url.search, env.SID_ENDPOINT);
    return fetch(upstream, { method: request.method, headers, redirect: 'manual' });
  }
};
