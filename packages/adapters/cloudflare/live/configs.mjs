/* global process */
// Writes the Wrangler configurations of this project's upstream-operator and Cloudflare for SaaS live tests (README.md,
// The upstream-operator and Cloudflare for SaaS setups) into live/.out/, from the hostnames in the environment. Not for
// deployers. upstream.sh and saas.sh run it; see either for the variables.
//
//   node live/configs.mjs upstream       # .out/endpoint.json, .out/forward.json
//   node live/configs.mjs saas           # .out/saas.json, .out/saas-site.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '.out');

function need(name) {
  const value = process.env[name] ?? '';
  if (value === '') throw new Error(`Set ${name}`);
  return value;
}

/**
 * One publisher site's settings, as the Cloudflare e2e environment's (wrangler.jsonc, env.e2e) so the Playwright tests
 * pass against it: no pixel caching, reflect with uid1 (on the site's cookie domain) and _ga, and clickid; plus ip and
 * geo, which the live checks read.
 */
function e2eSite(cookieDomain) {
  return {
    SID_COOKIE_DOMAIN: cookieDomain,
    SID_SYNC_CACHE_SECONDS: '0',
    SID_MODULES: 'ip,geo,reflect,clickid',
    SID_MODULE_CONFIG: {
      reflect: {
        cookies: [
          { name: 'uid1', maxAgeDays: 365, domain: cookieDomain, httpOnly: false, restore: true },
          { name: '_ga', maxAgeDays: 400, restore: true }
        ]
      }
    }
  };
}

// Every Worker: no workers.dev, no logs, and the date wrangler.jsonc uses.
const common = { compatibility_date: '2026-11-01', workers_dev: false, observability: { enabled: false } };
// The SharedID Edge Worker, from this package's source (relative to .out/).
const sharedIdWorker = { ...common, main: '../../src/index.ts', minify: true };

function write(name, config) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify(config, null, 2)}\n`);
  process.stdout.write(`live/.out/${name}.json\n`);
}

const kind = process.argv[2];
if (kind === 'upstream') {
  const endpoint = need('UO_ENDPOINT_HOST');
  const hosts = { [need('UO_CLOUDFRONT_PUBLISHER_HOST')]: e2eSite(need('UO_CLOUDFRONT_COOKIE_DOMAIN')) };
  const cloudflarePublisher = process.env['UO_CLOUDFLARE_PUBLISHER_HOST'] ?? '';
  // The second publisher, with its own cookie domain: the one Prebid.js writes _pubcid on there.
  if (cloudflarePublisher !== '') hosts[cloudflarePublisher] = e2eSite(need('UO_CLOUDFLARE_COOKIE_DOMAIN'));
  // Optionally a third, on the default settings (host-only cookies), for the conformance suite's default cases.
  const conformancePublisher = process.env['UO_CLOUDFLARE_CONFORMANCE_HOST'] ?? '';
  if (conformancePublisher !== '') hosts[conformancePublisher] = { SID_COOKIE_DOMAIN: 'host-only', SID_MODULES: '' };
  write('endpoint', {
    ...sharedIdWorker,
    name: process.env['UO_ENDPOINT_WORKER'] ?? 'sharedid-saleshouse',
    routes: [{ pattern: endpoint, custom_domain: true }],
    // docs/upstream-operators.md's worked example: trusted upstream (SID_UPSTREAM_SECRETS is a Worker secret), the
    // recipes' header names, and each publisher's site in SID_HOSTS.
    vars: {
      SID_MODULES: 'ip,geo,reflect,clickid',
      SID_CLIENT_IP_HEADER: 'x-sid-client-ip',
      SID_LOCATION_HEADERS: JSON.stringify({ country: 'x-sid-country', regionCode: 'x-sid-region' }),
      SID_HOSTS: JSON.stringify(hosts)
    }
  });
  if (cloudflarePublisher !== '') {
    write('forward', {
      ...common,
      name: process.env['UO_FORWARD_WORKER'] ?? 'sharedid-saleshouse-forward',
      main: '../forward.js',
      routes: [cloudflarePublisher, conformancePublisher]
        .filter(host => host !== '')
        .map(host => ({ pattern: `${host}/_sid/*`, zone_name: need('UO_CLOUDFLARE_PUBLISHER_ZONE') })),
      vars: { SID_ENDPOINT: `https://${endpoint}` }
    });
  }
} else if (kind === 'saas') {
  const zone = need('SAAS_ZONE');
  const listed = need('SAAS_HOSTNAME');
  write('saas', {
    ...sharedIdWorker,
    name: process.env['SAAS_WORKER'] ?? 'sharedid-saas',
    // Every hostname on the SaaS zone, custom hostnames included; the zone's more specific routes still win.
    routes: [{ pattern: '*/_sid/*', zone_name: zone }],
    // Only the listed custom hostname has SharedID Edge; any other gets a 404 (docs/hosting-companies.md).
    vars: { SID_MODULES: 'ip,geo,reflect,clickid', SID_HOSTS: JSON.stringify({ [listed]: e2eSite(need('SAAS_COOKIE_DOMAIN')) }) }
  });
  // The hosted sites: the e2e test page on every custom hostname, as the SaaS customers' pages. The route is */*, as
  // in Cloudflare's "Workers as your fallback origin": a route on one custom hostname (saas.publisher.example/*)
  // would beat */_sid/*, since a route's hostname counts before its path. The zone's own hostnames with routes of
  // their own keep them.
  write('saas-site', {
    ...common,
    name: process.env['SAAS_SITE_WORKER'] ?? 'sharedid-saas-site',
    assets: { directory: '../../../../../e2e/site/public' },
    routes: [{ pattern: '*/*', zone_name: zone }]
  });
} else {
  throw new Error('Usage: node live/configs.mjs upstream|saas');
}
