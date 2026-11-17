import { createHandler, resolveConfig } from '@sharedid-edge/core';
import { describe, expect, it } from 'vitest';
import { gppModule, gppSectionIds, gppSignal, sectionReason, US_SECTIONS } from '../src/index.js';
import { base64, core, fibonacci, gpp, int, range, withHeader } from './encode.js';

const UUID = 'c29cb2ae-769d-42f6-891a-f53cadee823d';
const MINTED = '11111111-2222-4333-8444-555555555555';
// The TCF EU v2 section of the IAB's own GPP string examples (Consent String Specification, "GPP String Examples").
const TCF_SECTION = 'CPXxRfAPXxRfAAfKABENB-CgAAAAAAAAAAYgAAAAAAAA';
// A TC string with publisher consent for purposes 1 and 2, as in the conformance cases.
const TC_ALLOWS = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.eAAAAAAAAA';

/** US National, version 1: 9 Int(2) fields, 12 sensitive data, 2 known child, 4 more (27 fields). */
const usnat1 = (set: Record<number, number> = {}): string => core(1, 27, set);
/** US National, version 2: 16 sensitive data and 3 known child (32 fields). */
const usnat2 = (set: Record<number, number> = {}): string => core(2, 32, set);
/** California: 5 Int(2) fields, 9 sensitive data, 2 known child, 4 more (20 fields). */
const usca = (set: Record<number, number> = {}): string => core(1, 20, set);
/** Colorado: 5 Int(2) fields, 7 sensitive data, known child, 3 more (16 fields). */
const usco = (set: Record<number, number> = {}): string => core(1, 16, set);

describe('the encoding (the IAB Consent String Specification)', () => {
  it('reads the header examples of the specification', () => {
    expect(gppSectionIds('DBABM')).toEqual([2]);
    expect(gppSectionIds('DBACNY')).toEqual([2, 6]);
    expect(gppSectionIds('DBABjw')).toEqual([5, 6]);
  });

  it('reads Fibonacci ranges with groups and offsets, as the specification\'s example (3, 5 to 8)', () => {
    // int(12) = 2, single 3, group from offset 2 (5) of length 3 (to 8): the specification's Range (Fibonacci) example.
    expect(gppSectionIds(base64(`${int(3, 6)}${int(1, 6)}000000000010` + '0' + '0011' + '1' + '011' + '0011'))).toEqual([3, 5, 6, 7, 8]);
    expect(fibonacci(1)).toBe('11');
    expect(fibonacci(5)).toBe('00011');
    expect(gppSectionIds(base64(`${int(3, 6)}${int(1, 6)}${range([7, 8, 12])}`))).toEqual([7, 8, 12]);
  });

  it('refuses a header that isn\'t one', () => {
    for (const header of ['', 'DBA', 'CBABM', 'DCABM', 'DB+BM', 'DBAB', '1YNN']) expect(() => gppSectionIds(header)).toThrow(RangeError);
  });
});

describe('sectionReason', () => {
  it('reads each US National opt-out, version 1 and 2', () => {
    for (const encode of [usnat1, usnat2]) {
      expect(sectionReason(7, encode({ 6: 2, 7: 2, 8: 2 }))).toBeUndefined();
      expect(sectionReason(7, encode({ 6: 1 }))).toBe('usnat: opted out of sale');
      expect(sectionReason(7, encode({ 6: 2, 7: 1 }))).toBe('usnat: opted out of sharing');
      expect(sectionReason(7, encode({ 8: 1 }))).toBe('usnat: opted out of targeted advertising');
    }
    // The notices and sensitive data at 1 aren't opt-outs.
    expect(sectionReason(7, usnat1({ 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 9: 1, 20: 1, 23: 1, 24: 1 }))).toBeUndefined();
  });

  it('reads the known-child fields: any "no consent" denies', () => {
    expect(sectionReason(7, usnat1({ 21: 2, 22: 1 }))).toBe('usnat: no consent for a known child');
    expect(sectionReason(7, usnat2({ 27: 1 }))).toBe('usnat: no consent for a known child');
    expect(sectionReason(7, usnat2({ 25: 2, 26: 2, 27: 2 }))).toBeUndefined();
    expect(sectionReason(8, usca({ 15: 1 }))).toBe('usca: no consent for a known child');
    expect(sectionReason(10, usco({ 12: 1 }))).toBe('usco: no consent for a known child');
    expect(sectionReason(10, usco({ 11: 1, 13: 1 }))).toBeUndefined();
  });

  it('reads the state sections\' own layouts', () => {
    expect(sectionReason(8, usca({ 3: 1 }))).toBe('usca: opted out of sale');
    expect(sectionReason(8, usca({ 4: 1 }))).toBe('usca: opted out of sharing');
    expect(sectionReason(10, usco({ 4: 1 }))).toBe('usco: opted out of targeted advertising');
    // Utah and Iowa have a fourth notice before the opt-outs.
    expect(sectionReason(11, core(1, 17, { 3: 1 }))).toBeUndefined();
    expect(sectionReason(11, core(1, 17, { 4: 1 }))).toBe('usut: opted out of sale');
    expect(sectionReason(18, core(1, 18, { 5: 1 }))).toBe('usia: opted out of targeted advertising');
    // New Jersey: 10 sensitive data fields, then 5 known-child fields.
    expect(sectionReason(21, core(1, 24, { 14: 1 }))).toBeUndefined();
    expect(sectionReason(21, core(1, 24, { 19: 1 }))).toBe('usnj: no consent for a known child');
  });

  it('reads the later sections with or without their section header', () => {
    // Indiana: MspaVersion, then MspaCoveredTransaction, MspaMode, three notices, sale, targeted advertising, known child.
    const fields = { 1: 1, 5: 1 };
    expect(sectionReason(25, core(0, 9, fields))).toBe('usin: opted out of sale');
    expect(sectionReason(25, withHeader(25, 1, 0, 9, fields))).toBe('usin: opted out of sale');
    expect(sectionReason(25, withHeader(25, 1, 0, 9, { 7: 1 }))).toBe('usin: no consent for a known child');
    // The header as its own subsection, the core in the next.
    const header = base64(int(25, 6) + int(1, 6) + range([]));
    expect(sectionReason(25, `${header}.${core(0, 9, { 6: 1 })}`)).toBe('usin: opted out of targeted advertising');
    // Maryland has no known-child field.
    expect(sectionReason(24, withHeader(24, 1, 0, 8, { 7: 1 }))).toBeUndefined();
    expect(sectionReason(24, withHeader(24, 1, 0, 8, { 6: 1 }))).toBe('usmd: opted out of targeted advertising');
  });

  it('reads US National version 3 (with a section header): MspaOptOut', () => {
    // MspaVersion, MspaNotice, MspaOptOut, MspaId Int(14) (seven more Int(2)).
    expect(sectionReason(7, withHeader(7, 3, 5, 9, { 0: 1, 1: 1 }))).toBe('usnat: opted out');
    expect(sectionReason(7, withHeader(7, 3, 5, 9, { 0: 1, 1: 2 }))).toBeUndefined();
  });

  it('throws on what it can\'t read: a missing or short section, an unknown version, an invalid value', () => {
    const unreadable: readonly (readonly [number, string | undefined])[] = [
      [7, undefined], [7, ''], [7, 'B'], [7, '!!!'],
      [7, core(3, 27)], // US National version 3 without its section header
      [7, withHeader(7, 1, 0, 9)], // a section header with a version that isn't 3
      [8, core(2, 20)], // California version 2
      [8, usca({ 3: 3 })], // an Int(2) of 3
      [25, withHeader(25, 2, 0, 9)] // Indiana version 2
    ];
    for (const [id, text] of unreadable) expect(() => sectionReason(id, text)).toThrow(RangeError);
    // The header says there are no more subsections, and there are two.
    expect(() => sectionReason(25, `${base64(int(25, 6) + int(1, 6) + range([]))}.AA.AA`)).toThrow(RangeError);
  });

  it('knows the US sections of the IAB\'s section list, 7 to 27', () => {
    expect(Object.keys(US_SECTIONS).map(Number)).toEqual(Array.from({ length: 21 }, (_, i) => i + 7));
  });
});

describe('gppSignal', () => {
  it('denies on an opt-out in a section gpp_sid lists, whatever else is in the string', () => {
    const string = gpp([[2, TCF_SECTION], [6, '1YNN'], [7, usnat1({ 6: 1 })]]);
    expect(gppSignal(string, [2, 6, 7])).toEqual({ consent: 'denied', reason: 'usnat: opted out of sale' });
    expect(gppSignal(string, [7])).toEqual({ consent: 'denied', reason: 'usnat: opted out of sale' });
  });

  it('changes nothing without an opt-out', () => {
    expect(gppSignal(gpp([[7, usnat1({ 6: 2, 7: 2, 8: 2 })]]), [7])).toBeUndefined();
    expect(gppSignal(gpp([[8, usca()]]), [8])).toBeUndefined();
  });

  it('ignores sections gpp_sid doesn\'t list, and non-US sections', () => {
    const optedOut = gpp([[2, TCF_SECTION], [7, usnat1({ 6: 1 })]]);
    expect(gppSignal(optedOut, [2])).toBeUndefined();
    expect(gppSignal(optedOut, undefined)).toBeUndefined();
    expect(gppSignal(optedOut, [])).toBeUndefined();
    // uspv1 (6) and the IAB's own example strings: no US section of this module.
    expect(gppSignal('DBACNY~CPXxRfAPXxRfAAfKABENB-CgAAAAAAAAAAYgAAAAAAAA~1YNN', [2, 6])).toBeUndefined();
    // Not even read when gpp_sid lists no US section.
    expect(gppSignal('not a GPP string', [2])).toBeUndefined();
  });

  it('fails closed when gpp_sid lists a US section it can\'t read', () => {
    expect(gppSignal(undefined, [7])).toEqual({ consent: 'denied', reason: 'unreadable GPP string' });
    expect(gppSignal('not a GPP string', [7])).toEqual({ consent: 'denied', reason: 'unreadable GPP string' });
    // gpp_sid lists a section the string doesn't have.
    expect(gppSignal(gpp([[2, TCF_SECTION]]), [2, 8])).toEqual({ consent: 'denied', reason: 'usca: unreadable' });
    expect(gppSignal(gpp([[8, 'AA!']]), [8])).toEqual({ consent: 'denied', reason: 'usca: unreadable' });
    expect(gppSignal(gpp([[8, usca()]]).split('~')[0], [8])).toEqual({ consent: 'denied', reason: 'usca: unreadable' });
  });

  it('takes the first denial in gpp_sid order', () => {
    const string = gpp([[7, usnat1({ 8: 1 })], [8, usca({ 3: 1 })]]);
    expect(gppSignal(string, [8, 7])).toEqual({ consent: 'denied', reason: 'usca: opted out of sale' });
    expect(gppSignal(string, [7, 8])).toEqual({ consent: 'denied', reason: 'usnat: opted out of targeted advertising' });
  });
});

describe('the gpp module through the handler', () => {
  const handler = createHandler({ config: resolveConfig({ SID_MODULES: 'gpp' }), modules: [gppModule], mintId: () => MINTED });
  const get = (path: string, cookie = '', headers: Record<string, string> = {}): Request => new Request(`https://www.example.com${path}`, { headers: { Cookie: cookie, ...headers } });
  const setCookie = (response: Response, name: string): string | undefined => response.headers.getSetCookie().find(c => c.startsWith(`${name}=`));
  const query = (string: string, sid: string): string => `gpp=${encodeURIComponent(string)}&gpp_sid=${sid}`;
  const optedOut = query(gpp([[7, usnat1({ 6: 1 })]]), '7');

  it('denies and deletes the ID on an opt-out, on /sync and /v1', async () => {
    const sync = await handler(get(`/_sid/sync?${optedOut}`, `_pubcid=${UUID}`));
    expect(sync.headers.get('X-SharedID-Status')).toBe('denied: gpp: usnat: opted out of sale');
    expect(setCookie(sync, '_pubcid')).toMatch(/^_pubcid=;.*Max-Age=0/);
    const v1 = await handler(get(`/_sid/v1?${optedOut}`, `_pubcid=${UUID}`));
    expect(v1.headers.get('X-SharedID-Status')).toBe('denied: gpp: usnat: opted out of sale');
    expect(await v1.json()).toMatchObject({ ext: { modules: { gpp: { status: 'empty' } } } });
  });

  it('changes nothing without an opt-out', async () => {
    const response = await handler(get(`/_sid/v1?${query(gpp([[7, usnat1({ 6: 2 })]]), '7')}`));
    expect(response.headers.get('X-SharedID-Status')).toBeNull();
    expect(setCookie(response, '_pubcid')).toContain(MINTED);
  });

  it('denies over a TC string that allows storage, and never weakens GPC, COPPA, opt-out or TCF', async () => {
    expect((await handler(get(`/_sid/sync?gdpr=1&gdpr_consent=${TC_ALLOWS}&${optedOut}`))).headers.get('X-SharedID-Status')).toBe('denied: gpp: usnat: opted out of sale');
    const clean = query(gpp([[7, usnat1({ 6: 2, 7: 2, 8: 2 })]]), '7');
    expect((await handler(get(`/_sid/sync?${clean}`, '', { 'Sec-GPC': '1' }))).headers.get('X-SharedID-Status')).toBe('denied: gpc');
    expect((await handler(get(`/_sid/sync?coppa=1&${clean}`))).headers.get('X-SharedID-Status')).toBe('denied: coppa');
    expect((await handler(get(`/_sid/sync?${clean}`, '_pubcid_optout=1'))).headers.get('X-SharedID-Status')).toBe('denied: opt-out');
    expect((await handler(get(`/_sid/sync?gdpr=1&${clean}`))).headers.get('X-SharedID-Status')).toBe('denied: tcf: GDPR applies and there is no TC string');
  });

  it('fails closed on an unreadable string for a US section', async () => {
    const response = await handler(get('/_sid/sync?gpp=garbage&gpp_sid=8', `_pubcid=${UUID}`));
    expect(response.headers.get('X-SharedID-Status')).toBe('denied: gpp: unreadable GPP string');
    expect(setCookie(response, '_pubcid')).toMatch(/^_pubcid=;.*Max-Age=0/);
  });
});
