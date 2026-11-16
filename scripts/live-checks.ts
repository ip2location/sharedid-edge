// What the live tests' check scripts share (check-cloudfront.ts, check-live-site.ts): the /v1 payload's fields they
// read, the list of checks and its report. Not for deployers.

export interface Payload {
  readonly sharedid?: string;
  readonly ortb2?: {
    readonly device?: {
      readonly ip?: string;
      readonly ipv6?: string;
      readonly geo?: { readonly country?: string; readonly region?: string; readonly city?: string; readonly utcoffset?: number };
      readonly sua?: { readonly browsers?: readonly { readonly brand: string }[]; readonly platform?: { readonly brand: string } };
      readonly ext?: { readonly traffic?: { readonly bot?: boolean; readonly botKind?: string } };
    };
  };
  readonly ext?: { readonly modules?: Readonly<Record<string, { readonly status: string }>> };
}

function isPayload(value: unknown): value is Payload {
  return typeof value === 'object' && value !== null && (value as { v?: unknown }).v === 1;
}

/** GETs a /v1 URL; the payload is undefined unless the body is payload version 1. */
export async function v1(url: string, headers: Record<string, string> = {}): Promise<{ response: Response; payload: Payload | undefined }> {
  const response = await fetch(url, { headers });
  const body: unknown = await response.json().catch(() => undefined);
  return { response, payload: isPayload(body) ? body : undefined };
}

/** The client IP the ip module reported, IPv4 or IPv6. */
export function clientIp(payload: Payload | undefined): string | undefined {
  return payload?.ortb2?.device?.ip ?? payload?.ortb2?.device?.ipv6;
}

/** The addresses this machine's requests come from, as two echo services see them; empty when neither answers. */
async function publicIps(): Promise<string[]> {
  const ips: string[] = [];
  const trace = await fetch('https://cloudflare.com/cdn-cgi/trace').then(r => r.text()).catch(() => '');
  const traced = /^ip=(.+)$/m.exec(trace)?.[1]?.trim();
  if (traced !== undefined) ips.push(traced);
  // AWS's own echo service.
  const checkip = (await fetch('https://checkip.amazonaws.com/').then(r => (r.ok ? r.text() : '')).catch(() => '')).trim();
  if (checkip !== '') ips.push(checkip);
  return ips;
}

/** Records one check: its name, whether it passed, and what was seen. */
export type CheckFn = (name: string, ok: boolean, detail: string) => void;

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Runs `run`, which records checks with the `check` it's given, then prints them all and sets the exit code: 1 when
 * any failed or `run` threw (reported as a failed check named `reachable`).
 */
export async function runChecks(subject: string, run: (check: CheckFn) => Promise<void>, passed: string): Promise<void> {
  const checks: Check[] = [];
  try {
    await run((name, ok, detail) => { checks.push({ name, ok, detail }); });
  } catch (error) {
    checks.push({ name: 'reachable', ok: false, detail: `${subject}: ${error instanceof Error ? error.message : String(error)}` });
  }
  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed++;
    console.log(`${(c.ok ? 'ok' : 'FAIL').padEnd(4)} ${c.name} - ${c.detail}`);
  }
  console.log(failed === 0 ? `\n${passed}` : `\n${subject}: ${String(failed)} check(s) failed.`);
  process.exitCode = failed === 0 ? 0 : 1;
}

/** Checks that the ip module reported this machine's address (when an echo service could tell); returns that address. */
export async function checkClientIp(check: CheckFn, name: string, payload: Payload | undefined): Promise<string | undefined> {
  const ip = clientIp(payload);
  const expected = await publicIps();
  check(name, ip !== undefined && (expected.length === 0 || expected.includes(ip)),
    `device.ip(v6): ${ip ?? 'none'}; echo services: ${expected.length === 0 ? 'unavailable' : expected.join(', ')}`);
  return ip;
}
