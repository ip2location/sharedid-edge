// Checks the live setups as a visitor in the EU sees them: this project's live tests (.github/actions/eu-visitor;
// packages/adapters/aws-lambda/README.md, Live tests), not for deployers.
//
//   npx tsx scripts/check-eu-visitor.ts --target https://e2e.sharedid.dev/_sid [--target …]
//                                       [--geo https://pub.example/_sid …] [--function sharedid-eu-visitor]
//                                       [--region eu-central-1]
//
// It invokes the function sharedid-eu-visitor in eu-central-1 (packages/adapters/aws-lambda/live/eu-visitor.yaml) with
// `aws lambda invoke` (AWS_CLI, default aws, with the usual credentials), so every request comes from a German address
// and the CDN in front of each target sees an EU visitor. --target and --geo are a SharedID Edge base path (…/_sid);
// --geo marks one whose SID_MODULES include geo. For each, with no gdpr parameter, so GDPR follows from the location:
//
//   - /v1 without a TC string is denied for GDPR (X-SharedID-Status), with no ID and no Set-Cookie;
//   - /sync without a TC string sets no cookie, and is denied for GDPR;
//   - with a TC string that consents to Purposes 1 and 2 (the publisher segment; conformance/cases/consent.json),
//     /v1 returns an ID and sets _pubcid to it, and /sync sets _pubcid to the ID Prebid.js sends;
//   - with --geo, device.geo.country is an EU member state.
//
// First, it checks that the function's address is in the EU, as Cloudflare sees it (/cdn-cgi/trace).
import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { EU_COUNTRY_CODES } from '@sharedid-edge/core';
import { alpha3 } from '@sharedid-edge/module-geo';
import { CHROME, isPayload, runChecks, type CheckFn, type Payload } from './live-checks.js';

const execFile = promisify(execFileCallback);

const USAGE = 'Usage: check-eu-visitor --target https://<site>/_sid [--target …] [--geo https://<site>/_sid …] [--function sharedid-eu-visitor] [--region eu-central-1]';
const { values } = parseArgs({
  options: {
    target: { type: 'string', multiple: true, default: [] },
    geo: { type: 'string', multiple: true, default: [] },
    function: { type: 'string', default: 'sharedid-eu-visitor' },
    region: { type: 'string', default: 'eu-central-1' },
    help: { type: 'boolean', default: false }
  }
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const base = (url: string): string => url.replace(/\/+$/, '');
const geoTargets = new Set(values.geo.map(base));
const targets = [...new Set([...values.target.map(base), ...geoTargets])];
if (targets.length === 0 || targets.some(t => !t.startsWith('https://'))) {
  console.error(USAGE);
  process.exit(2);
}

// What core answers when GDPR applies (here: from the visitor's location) and there's no TC string.
const GDPR_DENIED = 'denied: tcf: GDPR applies and there is no TC string';
const EU_ALPHA_3 = new Set([...EU_COUNTRY_CODES].map(code => alpha3(code)));
const TRACE = 'https://www.cloudflare.com/cdn-cgi/trace';

const CONSENTING_CASE = 'sets the cookie with publisher consent for purposes 1 and 2';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The conformance suite's TC string with publisher consent for Purposes 1 and 2, which the default settings accept. */
function consentingTcString(): string {
  const file: unknown = JSON.parse(readFileSync(new URL('../conformance/cases/consent.json', import.meta.url), 'utf8'));
  const cases = isRecord(file) ? file['cases'] : undefined;
  const found: unknown = Array.isArray(cases) ? cases.find((c: unknown) => isRecord(c) && c['name'] === CONSENTING_CASE) : undefined;
  const request = isRecord(found) ? found['request'] : undefined;
  const path = isRecord(request) ? request['path'] : undefined;
  const tcString = typeof path === 'string' ? new URL(path, 'https://x.invalid').searchParams.get('gdpr_consent') : null;
  if (tcString === null) throw new Error('conformance/cases/consent.json has no consenting TC string');
  return tcString;
}

interface VisitRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** One response, as the function returns it (live/eu-visitor.yaml). */
interface Visit {
  readonly url: string;
  readonly status?: number;
  readonly setCookie?: readonly string[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly json?: unknown;
  readonly text?: string;
  readonly error?: string;
}

function isVisit(value: unknown): value is Visit {
  return isRecord(value) && typeof value['url'] === 'string';
}

/** Invokes the function with the requests; its responses, in the same order. */
async function visit(requests: readonly VisitRequest[]): Promise<{ region: string | undefined; visits: Visit[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'sid-eu-visitor-'));
  try {
    const out = join(dir, 'out.json');
    const { stdout } = await execFile(process.env['AWS_CLI'] ?? 'aws', [
      'lambda', 'invoke', '--function-name', values.function, '--region', values.region,
      '--cli-binary-format', 'raw-in-base64-out', '--payload', JSON.stringify({ requests }), '--output', 'json', out
    ]);
    const meta: unknown = JSON.parse(stdout);
    const functionError = isRecord(meta) ? meta['FunctionError'] : undefined;
    // Lambda's own error type (Unhandled, say) only: the error payload could repeat the requests.
    if (functionError !== undefined) throw new Error(`the function failed: ${typeof functionError === 'string' ? functionError : 'error'}`);
    const result: unknown = JSON.parse(readFileSync(out, 'utf8'));
    const region = isRecord(result) ? result['region'] : undefined;
    const results = isRecord(result) ? result['results'] : undefined;
    if (!Array.isArray(results) || results.length !== requests.length || !results.every(isVisit)) {
      throw new Error('the function returned an unexpected result');
    }
    return { region: typeof region === 'string' ? region : undefined, visits: results };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function describe(v: Visit | undefined): string {
  if (v === undefined) return 'no response';
  if (v.error !== undefined) return `error: ${v.error}`;
  const status = v.headers?.['x-sharedid-status'];
  return `${String(v.status)}, ${String(v.setCookie?.length ?? 0)} Set-Cookie, X-SharedID-Status: ${status ?? 'none'}`;
}

function payloadOf(v: Visit | undefined): Payload | undefined {
  return isPayload(v?.json) ? v.json : undefined;
}

/** Whether the response set _pubcid to this ID. */
function setsId(v: Visit | undefined, id: string | undefined): boolean {
  return id !== undefined && v?.setCookie?.some(c => c.startsWith(`_pubcid=${id};`)) === true;
}

function denied(v: Visit | undefined): boolean {
  return v?.status === 200 && v.setCookie?.length === 0 && v.headers?.['x-sharedid-status'] === GDPR_DENIED;
}

async function run(check: CheckFn): Promise<void> {
  const tcString = consentingTcString();
  const requests: VisitRequest[] = [{ url: TRACE, headers: {} }];
  const ids = new Map<string, readonly [string, string]>();
  for (const target of targets) {
    // /sync as Prebid.js calls it on a first visit: ?id= is pubcid:<id>, encoded twice.
    const id = [randomUUID(), randomUUID()] as const;
    ids.set(target, id);
    const syncId = (n: 0 | 1): string => encodeURIComponent(encodeURIComponent(`pubcid:${id[n]}`));
    requests.push(
      { url: `${target}/v1`, headers: CHROME },
      { url: `${target}/sync?id=${syncId(0)}`, headers: CHROME },
      { url: `${target}/v1?gdpr_consent=${tcString}`, headers: CHROME },
      { url: `${target}/sync?id=${syncId(1)}&gdpr_consent=${tcString}`, headers: CHROME }
    );
  }
  const { region, visits } = await visit(requests);

  const trace = visits[0];
  const loc = /^loc=(.+)$/m.exec(trace?.text ?? '')?.[1]?.trim();
  check(`the visitor is in the EU (function in ${region ?? 'unknown region'}; Cloudflare's trace: loc=${loc ?? 'none'})`,
    region === values.region && loc !== undefined && EU_COUNTRY_CODES.has(loc), describe(trace));

  targets.forEach((target, i) => {
    const [plainV1, plainSync, consentV1, consentSync] = visits.slice(1 + i * 4, 5 + i * 4);
    const [, syncId] = ids.get(target) ?? [];
    const plain = payloadOf(plainV1);
    check(`${target}/v1 without a TC string: denied for GDPR, no ID, no Set-Cookie`,
      denied(plainV1) && plain !== undefined && plain.sharedid === undefined, describe(plainV1));
    if (geoTargets.has(target)) {
      const geo = plain?.ortb2?.device?.geo;
      check(`${target}/v1: the geo module places the visitor in an EU member state`,
        geo?.country !== undefined && EU_ALPHA_3.has(geo.country), `device.geo: ${JSON.stringify(geo ?? null)}`);
    }
    check(`${target}/sync without a TC string: no cookie, denied for GDPR`, denied(plainSync), describe(plainSync));
    const sharedid = payloadOf(consentV1)?.sharedid;
    check(`${target}/v1 with consent for Purposes 1 and 2: an ID, set as _pubcid`,
      consentV1?.status === 200 && consentV1.headers?.['x-sharedid-status'] === undefined && setsId(consentV1, sharedid),
      `${describe(consentV1)}, sharedid: ${sharedid ?? 'none'}`);
    check(`${target}/sync with consent for Purposes 1 and 2: sets _pubcid to Prebid.js's ID`,
      consentSync?.status === 200 && setsId(consentSync, syncId), describe(consentSync));
  });
}

await runChecks('EU visitor', run, `EU visitor: every check passed against ${String(targets.length)} target(s).`);
