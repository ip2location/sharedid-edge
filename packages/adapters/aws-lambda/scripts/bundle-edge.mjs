// Bundles the Lambda@Edge entry point (src/edge-lambda.ts, with core and the built-in modules) into one ESM file,
// deploy-edge/edge.mjs, with the settings baked in: Lambda@Edge has no environment variables. Its handler is
// `edge.handler`, and edge-template.yaml uploads deploy-edge/ as the code. Run `npm run build` first.
//
//   npm run bundle:edge -w @sharedid-edge/aws-lambda -- [--config edge.config.json] [--event-type origin-request|viewer-request]
//                                                       [--gdpr-without-location applies|client]
//
// The configuration file is a JSON object of SID_* settings, as the regional function's environment variables
// (SID_MODULE_CONFIG may be an object); edge.config.example.json is one. It's validated as the function validates it
// (edgeOptions in src/edge-env.ts: SID_COOKIE_DOMAIN required, trusted-upstream mode refused, and with viewer-request,
// modules that need the visitor's location refused), and an invalid one fails the build. Then the bundle is smoke-tested
// with a CloudFront event of the chosen type, and checked against the size budget and Lambda@Edge's limits.
//
// SID_MODULE_SECRETS may be set, and then ends up in the bundle: anyone who can read the function's code
// (lambda:GetFunction) can read it. See README.md, Lambda@Edge.
//
// --unbaked builds the same bundle without settings, reading them from globalThis.__SID_EDGE__ when it's loaded: only
// for the conformance suite's stand-in (conformance/src/lambda-edge-emulator.ts), which sets it per case file. A
// deployed unbaked bundle answers every request with a 500. Also --bowser, --module, --vendor-modules and --outdir
// <deploy* dir>, as for the regional bundle; see scripts/bundle-adapter.mjs.
import { Buffer } from 'node:buffer';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError } from '@sharedid-edge/core';
import { bundleAdapter } from '../../../../scripts/bundle-adapter.mjs';
import { readSettingsFile, SettingsFileError } from '../../../../scripts/settings-file.mjs';
import { edgeOptions } from '../dist/edge.js';

const ROOT = dirname(import.meta.dirname);
/** Lambda@Edge's limit on a function's compressed package, for viewer and origin events alike. */
const PACKAGE_LIMIT = 50 * 1024 * 1024;
/** The largest response a function may generate: 40 KB for viewer-request, 1 MB for origin-request (headers and body). */
const RESPONSE_LIMIT = { 'viewer-request': 40 * 1024, 'origin-request': 1024 * 1024 };
const show = path => relative(process.cwd(), path).split(sep).join('/');

function fail(message, code = 1) {
  console.error(`\nLambda@Edge build failed: ${message}`);
  process.exit(code);
}

/** The build baked into the bundle, once validated, for the smoke test. */
let baked;

const { outdir, outfile } = await bundleAdapter({
  root: ROOT,
  entry: 'src/edge-lambda.ts',
  file: 'edge.mjs',
  label: 'Lambda@Edge bundle',
  options: { platform: 'node', target: 'node24' },
  args: {
    outdir: { type: 'string', default: 'deploy-edge' },
    config: { type: 'string', default: 'edge.config.json' },
    'event-type': { type: 'string', default: 'origin-request' },
    'gdpr-without-location': { type: 'string', default: 'applies' },
    unbaked: { type: 'boolean', default: false }
  },
  variant: values => {
    if (values.unbaked) return { label: '(unbaked, for the conformance stand-in)' };
    const configFile = resolve(ROOT, String(values.config));
    try {
      const settings = readSettingsFile(configFile, {
        shown: show(configFile),
        missing: `no ${show(configFile)}. Copy edge.config.example.json to edge.config.json and set your values, or pass --config.`,
        what: 'a Lambda@Edge configuration',
        refuse: key => key.startsWith('SID_UPSTREAM_') || key === 'SID_CLIENT_IP_HEADER' || key === 'SID_LOCATION_HEADERS'
          ? `${key}: trusted-upstream mode isn't available on Lambda@Edge yet; use the regional function behind a publisher's CDN.`
          : undefined
      });
      baked = { settings, eventType: values['event-type'], gdprWithoutLocation: values['gdpr-without-location'] };
      // The function's own validation, so a build that passes starts.
      edgeOptions(baked);
    } catch (error) {
      if (error instanceof SettingsFileError) fail(error.message, 2);
      if (error instanceof ConfigError) fail(`${error.message} (in ${show(configFile)}, or the --event-type and --gdpr-without-location options).`, 2);
      throw error;
    }
    // A JSON string, as the entry point expects: settings are strings, and some (the module config) are JSON themselves.
    return { label: `(${baked.eventType})`, options: { define: { 'globalThis.__SID_EDGE__': JSON.stringify(JSON.stringify(baked)) } } };
  }
});

const files = readdirSync(outdir);
if (files.length !== 1 || files[0] !== 'edge.mjs') fail(`${basename(outdir)}/ must contain only edge.mjs, found: ${files.join(', ')}`);

if (baked !== undefined) await smokeTest(baked);

/**
 * Loads the bundle and sends it a first sync and a /v1, as CloudFront would with the chosen event: it must set the ID,
 * report no module errors, and answer within Lambda@Edge's response limit. Removes the bundle when it fails, so a
 * broken one isn't deployed.
 */
async function smokeTest(build) {
  const { handler } = await import(`${pathToFileURL(outfile).href}?t=${String(Date.now())}`);
  const options = edgeOptions(build);
  const config = options.hosts === undefined ? options.config : [...options.hosts.values()][0];
  const host = options.hosts === undefined ? `www.${(config.cookieDomain ?? 'example.com').replace(/^\./, '')}` : [...options.hosts.keys()][0];
  const base = config.basePath === '/' ? '' : config.basePath;
  const id = 'c29cb2ae-769d-42f6-891a-f53cadee823d';
  const event = (uri, querystring, extra = {}) => ({
    Records: [{
      cf: {
        config: { distributionDomainName: 'd111111abcdef8.cloudfront.net', eventType: build.eventType },
        request: {
          clientIp: '203.0.113.7',
          method: 'GET',
          uri,
          querystring,
          headers: {
            host: [{ key: 'Host', value: host }],
            // A browser's request, with the headers browsers send: the bot module's missingHeaders would otherwise call it
            // a likely bot, and with SID_SKIP_BOTS no ID would be set.
            'user-agent': [{ key: 'User-Agent', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' }],
            'accept-language': [{ key: 'Accept-Language', value: 'en-US,en;q=0.9' }],
            'sec-fetch-site': [{ key: 'Sec-Fetch-Site', value: 'same-origin' }],
            'sec-fetch-mode': [{ key: 'Sec-Fetch-Mode', value: 'no-cors' }],
            'sec-fetch-dest': [{ key: 'Sec-Fetch-Dest', value: 'image' }],
            ...(build.eventType === 'origin-request' ? { 'cloudfront-viewer-country': [{ key: 'CloudFront-Viewer-Country', value: 'US' }] } : {}),
            ...extra
          }
        }
      }
    }]
  });
  const problems = [];
  // gdpr=0: the smoke test checks the bundle, not consent; without a location, GDPR may apply to everyone.
  const sync = await handler(event(`${base}/sync`, `gdpr=0&id=pubcid%253A${id}`));
  if (sync.status !== '200' || !(sync.headers['set-cookie'] ?? []).some(c => c.value.startsWith(`${config.cookieName}=${id};`))) {
    problems.push(`a first sync got ${sync.status}${sync.status === '200' ? `, without the ${config.cookieName} cookie` : ''}`);
  }
  const v1 = await handler(event(`${base}/v1`, 'gdpr=0'));
  const payload = v1.bodyEncoding === 'text' && v1.status === '200' ? JSON.parse(v1.body) : undefined;
  const errors = Object.entries(payload?.ext?.modules ?? {}).filter(([, m]) => m?.status === 'error').map(([name]) => name);
  if (payload === undefined) problems.push(`/v1 got ${v1.status}`);
  if (errors.length > 0) problems.push(`modules report an error: ${errors.join(', ')} (check their SID_MODULE_CONFIG)`);
  for (const response of [sync, v1]) {
    const size = Buffer.byteLength(JSON.stringify(response));
    if (size > RESPONSE_LIMIT[build.eventType]) problems.push(`a response of ${String(size)} bytes is over the ${build.eventType} limit`);
  }
  if (problems.length > 0) {
    rmSync(outfile, { force: true });
    fail(`the smoke test failed: ${problems.join('; ')}. Nothing was written.`);
  }
  const size = statSync(outfile).size;
  console.log(`  Event: ${build.eventType}; GDPR without a location: ${build.gdprWithoutLocation}
  Smoke test: ok (a first sync sets ${config.cookieName}; /v1 answers${options.modules.length > 0 && config.modules.length > 0 ? ' with no module errors' : ''})
  Lambda@Edge package limit: ${String(size)} bytes uncompressed, of ${String(PACKAGE_LIMIT)} compressed${size > PACKAGE_LIMIT ? ' (OVER)' : ''}
  Handler: edge.handler; upload ${show(outdir)}/ (edge-template.yaml's CodeUri)${build.settings.SID_MODULE_SECRETS === undefined ? '' : `
  SID_MODULE_SECRETS is baked into ${show(outfile)}: anyone allowed lambda:GetFunction on the function can read it.`}`);
  if (size > PACKAGE_LIMIT) process.exitCode = 1;
}
