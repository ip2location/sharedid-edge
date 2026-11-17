import { defineModule, type ConsentHookContext, type ConsentSignal, type EdgeModule } from '@sharedid-edge/core';

/**
 * The consent management platforms the module reads, each from its own first-party cookie. The formats, and where
 * each is documented, are in the README ("CMP cookie formats").
 */
export const CMPS: readonly CmpName[] = ['cookiebot', 'onetrust', 'complianz', 'cookieyes', 'iubenda', 'borlabs'];

export type CmpName = 'cookiebot' | 'onetrust' | 'complianz' | 'cookieyes' | 'iubenda' | 'borlabs';

/** One CMP to read: its name, the categories that must all be granted, and the cookie (or, for Complianz, the prefix). */
export interface CmpReader {
  readonly cmp: CmpName;
  readonly categories: readonly string[];
  /**
   * The cookie name; for Complianz the prefix of its per-category cookies; for iubenda an exact `_iub_cs-…` name.
   * Undefined for the CMP's own default (for Complianz `cmplz_` and `cmplz_rt_`, for iubenda every `_iub_cs-…` cookie).
   */
  readonly cookie: string | undefined;
}

/** The module's parsed settings: the CMPs to read, in the order given. */
export interface CmpSettings {
  readonly readers: readonly CmpReader[];
}

/** Each CMP's advertising category, the default for `categories`. */
export const DEFAULT_CATEGORIES: Readonly<Record<CmpName, string>> = Object.freeze({
  cookiebot: 'marketing',
  onetrust: 'C0004',
  complianz: 'marketing',
  cookieyes: 'advertisement',
  iubenda: '5',
  borlabs: 'marketing'
});

/** What a CMP's cookie says about one category, or the whole CMP: undefined when it doesn't say (unknown). */
export type Answer = 'granted' | 'denied' | undefined;

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/;
const CATEGORY = /^[A-Za-z0-9_.:-]{1,64}$/;
const IUBENDA_PREFIX = '_iub_cs-';
const READER_KEYS: readonly string[] = ['categories', 'cookie'];

function fail(message: string): never {
  throw new TypeError(`cmp: ${message}`);
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** A non-empty list of category IDs without repeats. */
function isCategoryList(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  const list: readonly unknown[] = value;
  return list.length > 0 && list.every(c => typeof c === 'string' && CATEGORY.test(c)) && new Set(list).size === list.length;
}
const isCmp = (name: string): name is CmpName => (CMPS as readonly string[]).includes(name);

/**
 * Parses the module's `SID_MODULE_CONFIG` entry: an object keyed by CMP name (`cookiebot`, `onetrust`, `complianz`,
 * `cookieyes`, `iubenda`, `borlabs`), each `{ categories?: string[], cookie?: string }`. At least one CMP. Throws a
 * `TypeError` naming the setting on anything else; messages never repeat configured values.
 */
export function cmpSettings(config: Readonly<Record<string, unknown>>): CmpSettings {
  // The Cloudflare Snippet runs this when it's built and bundles the result as the module's config, with esbuild's
  // `define` setting this flag, so there the entry is already parsed and the rest of the parser drops out of the bundle.
  if ((globalThis as { __SID_PREVALIDATED__?: boolean }).__SID_PREVALIDATED__ === true) return config as unknown as CmpSettings;
  const readers: CmpReader[] = [];
  for (const [cmp, entry] of Object.entries(config)) {
    if (!isCmp(cmp)) fail(`unknown CMP; use ${CMPS.join(', ')}`);
    if (!isRecord(entry)) fail(`"${cmp}" must be an object`);
    for (const key of Object.keys(entry)) if (!READER_KEYS.includes(key)) fail(`"${cmp}" has an unknown setting; use ${READER_KEYS.join(', ')}`);
    const categories = entry['categories'] ?? [DEFAULT_CATEGORIES[cmp]];
    if (!isCategoryList(categories)) {
      fail(`"${cmp}.categories" must be a non-empty list of category IDs without repeats`);
    }
    const cookie = entry['cookie'];
    if (cookie !== undefined && (typeof cookie !== 'string' || !COOKIE_NAME.test(cookie))) fail(`"${cmp}.cookie" must be a cookie name`);
    if (cmp === 'iubenda' && cookie !== undefined && !cookie.startsWith(IUBENDA_PREFIX)) fail('"iubenda.cookie" must start with _iub_cs-');
    readers.push(Object.freeze({ cmp, categories: Object.freeze([...categories]), cookie }));
  }
  if (readers.length === 0) fail('name at least one CMP');
  return Object.freeze({ readers: Object.freeze(readers) });
}

/** Combines answers strictly: any denial denies; all granted grants; otherwise unknown. */
function all(answers: readonly Answer[]): Answer {
  if (answers.includes('denied')) return 'denied';
  return answers.length > 0 && answers.every(answer => answer === 'granted') ? 'granted' : undefined;
}

/** `decodeURIComponent`, or undefined for a malformed value. */
function decoded(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** URL-encoded JSON as an object, or undefined. */
function jsonObject(value: string): Readonly<Record<string, unknown>> | undefined {
  const text = decoded(value);
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** A boolean as an answer; anything else is unknown. */
const flag = (value: unknown): Answer => (value === true ? 'granted' : value === false ? 'denied' : undefined);

type Cookies = ReadonlyMap<string, string>;

/**
 * Cookiebot: `CookieConsent`, a URL-encoded JavaScript object literal such as
 * `{stamp:'…',necessary:true,preferences:false,statistics:true,marketing:false,method:'explicit',ver:1,utc:…}`.
 * `-1` means the visitor is outside the regions Cookiebot asks in: unknown. A category is `true` or `false`. A grant
 * counts only with `method:'explicit'` (Cookiebot counts an unknown method as implied); a denial counts either way.
 */
function cookiebot(cookies: Cookies, reader: CmpReader): Answer {
  const raw = cookies.get(reader.cookie ?? 'CookieConsent');
  if (raw === undefined || raw === '-1') return undefined;
  const text = decoded(raw);
  if (text === undefined || !text.startsWith('{') || !text.endsWith('}')) return undefined;
  const fields = new Map<string, string>();
  for (const part of text.slice(1, -1).split(',')) {
    const colon = part.indexOf(':');
    if (colon > 0) fields.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
  }
  const explicit = fields.get('method') === "'explicit'";
  return all(reader.categories.map(category => {
    const value = fields.get(category);
    return value === 'false' ? 'denied' : value === 'true' && explicit ? 'granted' : undefined;
  }));
}

/**
 * OneTrust: `OptanonConsent`, a URL-encoded query string whose `groups` is a comma list of `<group ID>:<0 or 1>`. It's
 * written before the visitor chooses, with the site's defaults, so it counts only once `OptanonAlertBoxClosed` is set
 * (OneTrust sets that when the visitor accepts, rejects, saves or closes the banner).
 */
function onetrust(cookies: Cookies, reader: CmpReader): Answer {
  const raw = cookies.get(reader.cookie ?? 'OptanonConsent');
  const closed = cookies.get('OptanonAlertBoxClosed');
  if (raw === undefined || closed === undefined || closed === '') return undefined;
  const groups = new Map<string, string>();
  // Read by hand rather than with URLSearchParams, which not every platform has (EdgeWorkers doesn't).
  const field = raw.split('&').find(pair => pair.startsWith('groups='));
  for (const entry of (decoded((field ?? '').slice('groups='.length).replaceAll('+', ' ')) ?? '').split(',')) {
    const colon = entry.lastIndexOf(':');
    if (colon > 0) groups.set(entry.slice(0, colon), entry.slice(colon + 1));
  }
  return all(reader.categories.map(group => {
    const value = groups.get(group);
    return value === '1' ? 'granted' : value === '0' ? 'denied' : undefined;
  }));
}

/**
 * Complianz: one cookie per category, `cmplz_<category>` (`cmplz_rt_<category>` on a multisite's root), `allow` or
 * `deny`. `deny` is always the visitor's. `allow` counts only with `cmplz_banner-status=dismissed` (the banner was
 * answered), since Complianz writes `allow` by itself in regions where it shows no banner.
 */
function complianz(cookies: Cookies, reader: CmpReader): Answer {
  let result: Answer;
  for (const prefix of reader.cookie === undefined ? ['cmplz_', 'cmplz_rt_'] : [reader.cookie]) {
    const values = reader.categories.map(category => cookies.get(prefix + category));
    if (values.every(value => value === undefined)) continue;
    const answered = cookies.get(`${prefix}banner-status`) === 'dismissed';
    const answer = all(values.map(value => (value === 'deny' ? 'denied' : value === 'allow' && answered ? 'granted' : undefined)));
    if (answer === 'denied') return answer;
    result ??= answer;
  }
  return result;
}

/**
 * CookieYes: `cookieyes-consent`, a comma list of `<key>:<value>`: `consentid`, `consent`, `action`, then each category
 * `yes` or `no`. It's written before the visitor chooses, with the defaults and an empty `action`; it counts only with
 * `action:yes`.
 */
function cookieyes(cookies: Cookies, reader: CmpReader): Answer {
  const raw = cookies.get(reader.cookie ?? 'cookieyes-consent');
  if (raw === undefined) return undefined;
  const fields = new Map<string, string>();
  for (const part of (decoded(raw) ?? '').split(',')) {
    const colon = part.indexOf(':');
    if (colon > 0) fields.set(part.slice(0, colon), part.slice(colon + 1));
  }
  if (fields.get('action') !== 'yes') return undefined;
  return all(reader.categories.map(category => {
    const value = fields.get(category);
    return value === 'yes' ? 'granted' : value === 'no' ? 'denied' : undefined;
  }));
}


/**
 * iubenda: `_iub_cs-<site or cookie policy ID>`, URL-encoded JSON whose `purposes` maps purpose IDs to `true` or
 * `false` (with per-purpose consent on). Every such cookie is read, unless `cookie` names one; they must agree.
 */
function iubenda(cookies: Cookies, reader: CmpReader): Answer {
  const values = reader.cookie === undefined
    ? [...cookies].filter(([name]) => name.startsWith(IUBENDA_PREFIX)).map(([, value]) => value)
    : [cookies.get(reader.cookie)].filter(value => value !== undefined);
  if (values.length === 0) return undefined;
  return all(values.map(value => {
    const purposes = jsonObject(value)?.['purposes'];
    return isRecord(purposes) ? all(reader.categories.map(id => flag(purposes[id]))) : undefined;
  }));
}

/**
 * Borlabs Cookie: `borlabs-cookie`, URL-encoded JSON whose `consents` maps each accepted group to its services. It's
 * written only when the visitor saves a choice, and lists only accepted groups, so a group that's missing is denied.
 */
function borlabs(cookies: Cookies, reader: CmpReader): Answer {
  const raw = cookies.get(reader.cookie ?? 'borlabs-cookie');
  const consents = raw === undefined ? undefined : jsonObject(raw)?.['consents'];
  if (!isRecord(consents)) return undefined;
  return all(reader.categories.map(group => (Array.isArray(consents[group]) ? 'granted' : 'denied')));
}

const PARSERS: Readonly<Record<CmpName, (cookies: Cookies, reader: CmpReader) => Answer>> = Object.freeze({ cookiebot, onetrust, complianz, cookieyes, iubenda, borlabs });

/**
 * What one CMP's cookie says for its categories: `denied` when any category is denied, `granted` when all are, and
 * otherwise (no cookie, no choice yet, or a value it can't read) undefined. Never throws.
 */
export function readCmp(cookies: ReadonlyMap<string, string>, reader: CmpReader): Answer {
  try {
    return PARSERS[reader.cmp](cookies, reader);
  } catch {
    return undefined;
  }
}

/**
 * The module's signal: the first CMP that denies, with the reason `<cmp>: no consent for <categories>`; otherwise a
 * grant when any CMP grants; otherwise nothing.
 */
export function cmpSignal(cookies: ReadonlyMap<string, string>, settings: CmpSettings): ConsentSignal | undefined {
  let granted = false;
  for (const reader of settings.readers) {
    const answer = readCmp(cookies, reader);
    if (answer === 'denied') return { consent: 'denied', reason: `${reader.cmp}: no consent for ${reader.categories.join(', ')}` };
    if (answer === 'granted') granted = true;
  }
  return granted ? { consent: 'granted' } : undefined;
}

/**
 * The `cmp` module: a consent provider that reads the consent cookies of CMPs that don't write a TCF TC string
 * (Cookiebot, OneTrust, Complianz, CookieYes, iubenda, Borlabs Cookie). Opt-in at build time: not in the built-in
 * list. It adds nothing to the payload; its `run` only checks the settings, so they show as an `error` in
 * `ext.modules.cmp` when they're invalid.
 */
export const cmpModule: EdgeModule = defineModule({
  name: 'cmp',
  consent(context: ConsentHookContext): ConsentSignal | undefined {
    return cmpSignal(context.cookies, cmpSettings(context.config));
  },
  run(context): undefined {
    cmpSettings(context.config);
    return undefined;
  }
});
