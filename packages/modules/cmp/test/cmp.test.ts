import { createHandler, resolveConfig } from '@sharedid-edge/core';
import { describe, expect, it } from 'vitest';
import { cmpModule, cmpSettings, cmpSignal, readCmp, type CmpReader } from '../src/index.js';

const UUID = 'c29cb2ae-769d-42f6-891a-f53cadee823d';
const MINTED = '11111111-2222-4333-8444-555555555555';

/** A request's cookies, as core parses them. */
const jar = (pairs: Record<string, string>): ReadonlyMap<string, string> => new Map(Object.entries(pairs));
const reader = (cmp: CmpReader['cmp'], categories?: readonly string[], cookie?: string): CmpReader =>
  cmpSettings({ [cmp]: { ...(categories === undefined ? {} : { categories }), ...(cookie === undefined ? {} : { cookie }) } }).readers[0] ?? reader(cmp);

// Cookiebot's CookieConsent: a JavaScript object literal, sent URL-encoded as Cookiebot writes it (`'` and `,` encoded).
const cookiebot = (fields: string): string => `{${fields}}`.replaceAll("'", '%27').replaceAll(',', '%2C');
const COOKIEBOT_EXPLICIT = cookiebot("stamp:'Ov4gD1JVnDnBaJv8K2wYQlyWlnNlT/AKO768tibZYdQGNj/EolraLw==',necessary:true,preferences:false,statistics:true,marketing:true,method:'explicit',ver:1,utc:1698057791350,region:'gb'");
// Cookiebot's own published example value (from its API documentation), with no `method`.
const COOKIEBOT_DOCS = '{stamp:%27-1%27%2Cnecessary:true%2Cpreferences:true%2Cstatistics:true%2Cmarketing:true%2Cver:2147483647%2Cutc:1646127963403}';
// OneTrust's OptanonConsent: a URL-encoded query string, with the groups from OneTrust's own example.
const optanon = (groups: string, extra = ''): string =>
  `isGpcEnabled=0&datestamp=Mon+Mar+27+2023+22%3A48%3A10+GMT-0400+(Eastern+Daylight+Time)&version=202303.1.0&isIABGlobal=false&hosts=&consentId=6fcfe4fe-8de9-4101-bdf9-5dad0faf2611&interactionCount=1&landingPath=NotLandingPage&groups=${encodeURIComponent(groups)}${extra}`;
const CLOSED = '2023-02-27T15:26:56.183Z';
const cookieyes = (action: string, advertisement: string): string =>
  `consentid:bFl2eFJBN05VS21WNWk5enpRNTNEZ3hxR0dDc3VmcFM,consent:yes,action:${action},necessary:yes,functional:no,analytics:no,performance:no,advertisement:${advertisement}`;
const json = (value: unknown): string => encodeURIComponent(JSON.stringify(value));
const iubenda = (purposes: Record<string, boolean> | undefined): string => json({ timestamp: '2026-01-01T00:00:00.000Z', version: '1.60.0', ...(purposes === undefined ? { consent: true } : { purposes }), id: 1234567 });
const borlabs = (consents: Record<string, string[]>): string => json({ consents, domainPath: 'example.com/', expires: 'Thu, 01 Jan 2027 00:00:00 GMT', uid: 'abcd1234-5678-90ab-cdef-1234567890ab', v3: true, version: 1 });

describe('cmpSettings', () => {
  it('takes each CMP with its advertising category by default, and categories and cookie names given', () => {
    expect(cmpSettings({ cookiebot: {}, onetrust: { categories: ['C0004', 'C0002'], cookie: 'OptanonConsent' } }).readers).toEqual([
      { cmp: 'cookiebot', categories: ['marketing'], cookie: undefined },
      { cmp: 'onetrust', categories: ['C0004', 'C0002'], cookie: 'OptanonConsent' }
    ]);
    for (const [cmp, category] of [['complianz', 'marketing'], ['cookieyes', 'advertisement'], ['iubenda', '5'], ['borlabs', 'marketing']] as const) {
      expect(cmpSettings({ [cmp]: {} }).readers[0]?.categories).toEqual([category]);
    }
  });

  it('refuses anything else, without repeating the values', () => {
    const invalid: Record<string, unknown>[] = [
      {},
      { didomi: {} },
      { cookiebot: true },
      { cookiebot: { category: 'marketing' } },
      { cookiebot: { categories: [] } },
      { cookiebot: { categories: 'marketing' } },
      { cookiebot: { categories: ['marketing', 'marketing'] } },
      { cookiebot: { categories: ['a b'] } },
      { cookiebot: { cookie: 'not a cookie' } },
      { cookiebot: { cookie: 7 } },
      { iubenda: { cookie: 'consent' } }
    ];
    for (const config of invalid) {
      expect(() => cmpSettings(config)).toThrow(TypeError);
      try {
        cmpSettings(config);
      } catch (error) {
        expect(String(error)).not.toMatch(/a b|not a cookie|didomi/);
      }
    }
  });
});

describe('readCmp', () => {
  it('Cookiebot: true and false per category; grants only explicit consent; -1 and no cookie are unknown', () => {
    expect(readCmp(jar({ CookieConsent: COOKIEBOT_EXPLICIT }), reader('cookiebot'))).toBe('granted');
    expect(readCmp(jar({ CookieConsent: COOKIEBOT_EXPLICIT }), reader('cookiebot', ['marketing', 'preferences']))).toBe('denied');
    expect(readCmp(jar({ CookieConsent: COOKIEBOT_EXPLICIT.replace('marketing:true', 'marketing:false') }), reader('cookiebot'))).toBe('denied');
    expect(readCmp(jar({ CookieConsent: COOKIEBOT_EXPLICIT.replace('explicit', 'implied') }), reader('cookiebot'))).toBeUndefined();
    expect(readCmp(jar({ CookieConsent: COOKIEBOT_EXPLICIT.replace('explicit', 'implied').replace('marketing:true', 'marketing:false') }), reader('cookiebot'))).toBe('denied');
    expect(readCmp(jar({ CookieConsent: COOKIEBOT_DOCS }), reader('cookiebot'))).toBeUndefined();
    expect(readCmp(jar({ CookieConsent: '-1' }), reader('cookiebot'))).toBeUndefined();
    expect(readCmp(jar({}), reader('cookiebot'))).toBeUndefined();
    expect(readCmp(jar({ CookieConsent: COOKIEBOT_EXPLICIT }), reader('cookiebot', ['advertising']))).toBeUndefined();
    expect(readCmp(jar({ Consent2: COOKIEBOT_EXPLICIT }), reader('cookiebot', undefined, 'Consent2'))).toBe('granted');
  });

  it('OneTrust: groups 1 and 0, only once the banner was answered (OptanonAlertBoxClosed)', () => {
    const onetrust = reader('onetrust');
    expect(readCmp(jar({ OptanonConsent: optanon('C0001:1,C0003:1,SSPD_BG:1,C0004:1,C0002:1'), OptanonAlertBoxClosed: CLOSED }), onetrust)).toBe('granted');
    expect(readCmp(jar({ OptanonConsent: optanon('C0001:1,C0003:0,C0004:0,C0002:1'), OptanonAlertBoxClosed: CLOSED }), onetrust)).toBe('denied');
    expect(readCmp(jar({ OptanonConsent: optanon('C0001:1,C0004:1,C0002:0'), OptanonAlertBoxClosed: CLOSED }), reader('onetrust', ['C0004', 'C0002']))).toBe('denied');
    // Written with the site's defaults before the visitor chose: not the visitor's answer.
    expect(readCmp(jar({ OptanonConsent: optanon('C0001:1,C0004:1') }), onetrust)).toBeUndefined();
    expect(readCmp(jar({ OptanonConsent: optanon('C0001:1,C0004:0') }), onetrust)).toBeUndefined();
    expect(readCmp(jar({ OptanonConsent: optanon('C0001:1'), OptanonAlertBoxClosed: CLOSED }), onetrust)).toBeUndefined();
    expect(readCmp(jar({ OptanonConsent: 'isGpcEnabled=0&datestamp=x&version=202303.1.0', OptanonAlertBoxClosed: CLOSED }), onetrust)).toBeUndefined();
    expect(readCmp(jar({ OptanonConsent: optanon('C0001:1,C0004:yes'), OptanonAlertBoxClosed: CLOSED }), onetrust)).toBeUndefined();
  });

  it('Complianz: deny always counts; allow only once the banner was answered; the multisite root prefix too', () => {
    const complianz = reader('complianz');
    expect(readCmp(jar({ cmplz_marketing: 'allow', 'cmplz_banner-status': 'dismissed' }), complianz)).toBe('granted');
    expect(readCmp(jar({ cmplz_marketing: 'allow' }), complianz)).toBeUndefined();
    expect(readCmp(jar({ cmplz_marketing: 'deny' }), complianz)).toBe('denied');
    expect(readCmp(jar({ cmplz_marketing: '', 'cmplz_banner-status': 'dismissed' }), complianz)).toBeUndefined();
    expect(readCmp(jar({ cmplz_rt_marketing: 'allow', 'cmplz_rt_banner-status': 'dismissed' }), complianz)).toBe('granted');
    expect(readCmp(jar({ cmplz_rt_marketing: 'deny', cmplz_marketing: 'allow', 'cmplz_banner-status': 'dismissed' }), complianz)).toBe('denied');
    expect(readCmp(jar({ cmplz_marketing: 'allow', cmplz_statistics: 'deny', 'cmplz_banner-status': 'dismissed' }), reader('complianz', ['marketing', 'statistics']))).toBe('denied');
    expect(readCmp(jar({ site_marketing: 'allow', 'site_banner-status': 'dismissed' }), reader('complianz', undefined, 'site_'))).toBe('granted');
  });

  it('CookieYes: yes and no per category, only with action:yes', () => {
    const yes = reader('cookieyes');
    expect(readCmp(jar({ 'cookieyes-consent': cookieyes('yes', 'yes') }), yes)).toBe('granted');
    expect(readCmp(jar({ 'cookieyes-consent': cookieyes('yes', 'no') }), yes)).toBe('denied');
    expect(readCmp(jar({ 'cookieyes-consent': cookieyes('', 'no') }), yes)).toBeUndefined();
    expect(readCmp(jar({ 'cookieyes-consent': cookieyes('', 'yes') }), yes)).toBeUndefined();
    expect(readCmp(jar({ 'cookieyes-consent': cookieyes('yes', '') }), yes)).toBeUndefined();
    expect(readCmp(jar({ 'cookieyes-consent': 'garbage' }), yes)).toBeUndefined();
  });

  it('iubenda: purposes true and false, from every _iub_cs- cookie, which must agree', () => {
    const iub = reader('iubenda');
    expect(readCmp(jar({ '_iub_cs-s1234': iubenda({ 1: true, 4: false, 5: true }) }), iub)).toBe('granted');
    expect(readCmp(jar({ '_iub_cs-s1234': iubenda({ 1: true, 5: false }) }), iub)).toBe('denied');
    expect(readCmp(jar({ '_iub_cs-s1234': iubenda({ 1: true }) }), iub)).toBeUndefined();
    expect(readCmp(jar({ '_iub_cs-s1234': iubenda(undefined) }), iub)).toBeUndefined();
    expect(readCmp(jar({ '_iub_cs-s1234': iubenda({ 5: true }), '_iub_cs-98765': iubenda({ 5: false }) }), iub)).toBe('denied');
    expect(readCmp(jar({ '_iub_cs-s1234': iubenda({ 5: true }), '_iub_cs-98765': iubenda({ 5: false }) }), reader('iubenda', undefined, '_iub_cs-s1234'))).toBe('granted');
    expect(readCmp(jar({ '_iub_cs-s1234': '%7Bnot json' }), iub)).toBeUndefined();
    expect(readCmp(jar({ '_iub_cs-s1234': '%E0%A4%A' }), iub)).toBeUndefined();
  });

  it('Borlabs Cookie: an accepted group is listed; one that is missing is denied', () => {
    const groups = reader('borlabs');
    expect(readCmp(jar({ 'borlabs-cookie': borlabs({ essential: ['borlabs-cookie'], marketing: ['google-ads'] }) }), groups)).toBe('granted');
    expect(readCmp(jar({ 'borlabs-cookie': borlabs({ essential: ['borlabs-cookie'] }) }), groups)).toBe('denied');
    expect(readCmp(jar({ 'borlabs-cookie': json({ uid: 'x' }) }), groups)).toBeUndefined();
    expect(readCmp(jar({ 'borlabs-cookie': 'not json' }), groups)).toBeUndefined();
    expect(readCmp(jar({}), groups)).toBeUndefined();
  });
});

describe('cmpSignal', () => {
  it('takes the first denial, then any grant, across CMPs', () => {
    const settings = cmpSettings({ cookieyes: {}, borlabs: {} });
    const granted = cookieyes('yes', 'yes');
    expect(cmpSignal(jar({ 'cookieyes-consent': granted }), settings)).toEqual({ consent: 'granted' });
    expect(cmpSignal(jar({ 'cookieyes-consent': granted, 'borlabs-cookie': borlabs({ essential: [] }) }), settings)).toEqual({ consent: 'denied', reason: 'borlabs: no consent for marketing' });
    expect(cmpSignal(jar({}), settings)).toBeUndefined();
  });
});

describe('the cmp module through the handler', () => {
  const handler = (config: Record<string, unknown>, env: Record<string, string> = {}): ReturnType<typeof createHandler> => createHandler({
    config: resolveConfig({ SID_MODULES: 'cmp', SID_MODULE_CONFIG: JSON.stringify({ cmp: config }), ...env }),
    modules: [cmpModule],
    mintId: () => MINTED
  });
  const get = (path: string, cookie: string, headers: Record<string, string> = {}): Request => new Request(`https://www.example.com${path}`, { headers: { Cookie: cookie, ...headers } });
  const setCookie = (response: Response, name: string): string | undefined => response.headers.getSetCookie().find(c => c.startsWith(`${name}=`));

  it('sets the ID where GDPR applies once the visitor accepted, and reports the module empty', async () => {
    const response = await handler({ cookieyes: {} })(get('/_sid/v1?gdpr=1', `cookieyes-consent=${cookieyes('yes', 'yes')}`));
    expect(response.headers.get('X-SharedID-Status')).toBeNull();
    expect(setCookie(response, '_pubcid')).toContain(MINTED);
    expect(await response.json()).toMatchObject({ sharedid: MINTED, ext: { modules: { cmp: { status: 'empty' } } } });
  });

  it('denies and deletes the ID outside GDPR when the visitor refused', async () => {
    const response = await handler({ cookieyes: {} })(get('/_sid/sync', `_pubcid=${UUID}; cookieyes-consent=${cookieyes('yes', 'no')}`));
    expect(response.headers.get('X-SharedID-Status')).toBe('denied: cmp: cookieyes: no consent for advertisement');
    expect(setCookie(response, '_pubcid')).toMatch(/^_pubcid=;.*Max-Age=0/);
  });

  it('keeps the current rules before a choice: denied where GDPR applies, allowed elsewhere', async () => {
    const before = `cookieyes-consent=${cookieyes('', 'no')}`;
    expect((await handler({ cookieyes: {} })(get('/_sid/sync?gdpr=1', before))).headers.get('X-SharedID-Status')).toBe('denied: tcf: GDPR applies and there is no TC string');
    expect((await handler({ cookieyes: {} })(get('/_sid/sync', before))).headers.get('X-SharedID-Status')).toBeNull();
  });

  it('never overrides GPC or a TC string with a grant', async () => {
    const accepted = `cookieyes-consent=${cookieyes('yes', 'yes')}`;
    expect((await handler({ cookieyes: {} })(get('/_sid/sync?gdpr=1', accepted, { 'Sec-GPC': '1' }))).headers.get('X-SharedID-Status')).toBe('denied: gpc');
    expect((await handler({ cookieyes: {} })(get('/_sid/sync?gdpr=1&gdpr_consent=not-a-tc-string', accepted))).headers.get('X-SharedID-Status')).toBe('denied: tcf: invalid TC string');
  });

  it('with invalid settings, denies everywhere (cmp: error) and reports the module as an error', async () => {
    const response = await handler({ didomi: {} })(get('/_sid/v1', `_pubcid=${UUID}`));
    expect(response.headers.get('X-SharedID-Status')).toBe('denied: cmp: error');
    expect(await response.json()).toMatchObject({ ext: { modules: { cmp: { status: 'error' } } } });
  });
});
