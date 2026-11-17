import { defineModule, type ConsentHookContext, type ConsentSignal, type EdgeModule } from '@sharedid-edge/core';

// Decodes just enough of an IAB Global Privacy Platform (GPP) string: the header's section IDs, and the opt-out and
// known-child fields of the US National and US state sections. The encoding is the IAB's "Consent String
// Specification" (Core/) and each section's technical specification (Sections/) in
// https://github.com/InteractiveAdvertisingBureau/Global-Privacy-Platform; the README's "What it reads" has the
// field positions and links.

/**
 * Where a section's fields are. Every US section's core subsection starts with an Int(6) (`Version`, or `MspaVersion`
 * in the sections with a section header) followed by Int(2) fields, so field `n` is at bit `6 + 2n`; fixed-length
 * lists (`N-Bitfield(2,x)`) are Int(2) fields in a row. -1 when the section has no such field.
 */
export type GppLayout = readonly [sale: number, sharing: number, targeted: number, mspa: number, child: number, children: number];

/** A US section: its client-side API name, and its layouts by form (see `sectionReason`). */
export type GppSection = readonly [name: string, layouts: Readonly<Record<string, GppLayout>>];

/** A state section with sale and targeted advertising opt-outs, and `children` known-child fields from `child`. */
const state = (sale: number, child: number, children = 1): GppLayout => [sale, -1, sale + 1, -1, child, children];
/** The later sections (Maryland, Indiana, Kentucky, Rhode Island), with a section header and `MspaVersion` first. */
const LATER = state(5, 7);
const NOTICES3 = state(3, 13);
const NOTICES3_CHILDREN3 = state(3, 13, 3);

/**
 * The US sections by GPP section ID (the IAB's "Section Information"), with their layouts. A layout's key is the
 * section's `Version` for sections without a section header; `h<version>` for a section header; and `m` for a
 * section the IAB's own reference library writes without its section header (starting at `MspaVersion`).
 */
export const US_SECTIONS: Readonly<Record<number, GppSection>> = Object.freeze<Record<number, GppSection>>({
  7: ['usnat', { 1: [6, 7, 8, -1, 21, 2], 2: [6, 7, 8, -1, 25, 3], h3: [-1, -1, -1, 1, -1, 0] }],
  8: ['usca', { 1: [3, 4, -1, -1, 14, 2] }],
  9: ['usva', { 1: NOTICES3 }],
  10: ['usco', { 1: state(3, 12) }],
  11: ['usut', { 1: state(4, 14) }],
  12: ['usct', { 1: NOTICES3_CHILDREN3 }],
  13: ['usfl', { 1: NOTICES3_CHILDREN3 }],
  14: ['usmt', { 1: NOTICES3_CHILDREN3 }],
  15: ['usor', { 1: state(3, 16, 3) }],
  16: ['ustx', { 1: NOTICES3 }],
  17: ['usde', { 1: state(3, 14, 5) }],
  18: ['usia', { 1: state(4, 14) }],
  19: ['usne', { 1: NOTICES3 }],
  20: ['usnh', { 1: NOTICES3_CHILDREN3 }],
  21: ['usnj', { 1: state(3, 15, 5) }],
  22: ['ustn', { 1: NOTICES3 }],
  23: ['usmn', { 1: NOTICES3 }],
  24: ['usmd', { h1: state(5, -1, 0), m: state(5, -1, 0) }],
  25: ['usin', { h1: LATER, m: LATER }],
  26: ['usky', { h1: LATER, m: LATER }],
  27: ['usri', { h1: LATER, m: LATER }]
});

const OPT_OUTS: readonly string[] = ['opted out of sale', 'opted out of sharing', 'opted out of targeted advertising', 'opted out'];
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE64URL = /^[\w-]+$/;

/** Thrown for anything that can't be read; caught in `gppSignal`, never seen outside the module. */
function unreadable(): never {
  throw new RangeError('gpp');
}

/** A base64url string as bits, six per character, as a string of `0` and `1`. */
function bits(text: string | undefined): string {
  if (text === undefined || !BASE64URL.test(text)) unreadable();
  let out = '';
  for (const char of text) out += ALPHABET.indexOf(char).toString(2).padStart(6, '0');
  return out;
}

/** An Int(`length`) at `at`. */
function int(b: string, at: number, length: number): number {
  const field = b.slice(at, at + length);
  if (field.length !== length) unreadable();
  return parseInt(field, 2);
}

/** An Int(Fibonacci) at `at`, and where the next field starts: bits weighted 1, 2, 3, 5, …, ended by `11`. */
function fibonacci(b: string, at: number): readonly [value: number, next: number] {
  const end = b.indexOf('11', at);
  if (end < 0) unreadable();
  let value = 0;
  for (let i = at, weight = 1, next = 2; i <= end; i++, [weight, next] = [next, weight + next]) if (b[i] === '1') value += weight;
  return [value, end + 2];
}

/** A Range(Fibonacci) at `at`: Int(12) entries, each a single ID or a group, as offsets from the last ID read. */
function range(b: string, at: number): readonly [ids: readonly number[], next: number] {
  const ids: number[] = [];
  let last = 0;
  let index = at + 12;
  for (let entry = int(b, at, 12); entry > 0; entry--) {
    const group = b[index++] === '1';
    let start: number;
    [start, index] = fibonacci(b, index);
    start += last;
    let length = 0;
    if (group) [length, index] = fibonacci(b, index);
    last = start + length;
    // Section IDs are small: a larger one isn't a GPP string, and mustn't make a long loop.
    if (last > 999) unreadable();
    for (let id = start; id <= last; id++) ids.push(id);
  }
  return [ids, index];
}

/** The GPP header's section IDs: Type Int(6) = 3, Version Int(6) = 1, then Sections, a Range(Fibonacci). */
export function gppSectionIds(header: string): readonly number[] {
  const b = bits(header);
  if (int(b, 0, 6) !== 3 || int(b, 6, 6) !== 1) unreadable();
  return range(b, 12)[0];
}

/**
 * Why one US section denies storage, or undefined when it doesn't; throws when it can't be read. Its first subsection
 * is read in one of three forms: with a section header (`SectionId` Int(6), the section's own ID, then `Version` Int(6)
 * and `SubSections`, a Range(Fibonacci); the core subsection follows in the same bits, or is the next `.` subsection);
 * a core subsection starting with `Version`; or, for the sections the IAB's reference library writes without the
 * header, a core subsection starting with `MspaVersion`.
 */
export function sectionReason(id: number, text: string | undefined): string | undefined {
  const section = US_SECTIONS[id];
  if (section === undefined) return undefined;
  const [name, layouts] = section;
  const subsections = (text ?? '').split('.');
  let b = bits(subsections[0]);
  let at = 0;
  const first = int(b, 0, 6);
  let key = String(first);
  if (first === id) {
    key = `h${String(int(b, 6, 6))}`;
    const [listed, next] = range(b, 12);
    if (subsections.length === listed.length + 2) b = bits(subsections[1]);
    else if (subsections.length === listed.length + 1) at = next;
    else unreadable();
  } else if (layouts['m'] !== undefined) {
    key = 'm';
  }
  const layout = layouts[key];
  if (layout === undefined) unreadable();
  /** Int(2) field `n` of the core subsection: 0 not applicable, 1 opted out (or no consent), 2 not; 3 is invalid. */
  const field = (n: number): number => {
    const value = int(b, at + 6 + 2 * n, 2);
    if (value === 3) unreadable();
    return value;
  };
  for (let kind = 0; kind < 4; kind++) {
    const n = layout[kind] ?? -1;
    if (n >= 0 && field(n) === 1) return `${name}: ${OPT_OUTS[kind] ?? ''}`;
  }
  const [, , , , child, children] = layout;
  for (let i = 0; i < children; i++) if (field(child + i) === 1) return `${name}: no consent for a known child`;
  return undefined;
}

/**
 * The module's signal for a request's `gpp` string and `gpp_sid` section IDs: the first applicable US section, in
 * `gpp_sid` order, that opts out of sale, sharing or targeted advertising, or has a known child without consent, denies
 * (`<section>: opted out of sale`, …). So does an applicable US section that can't be read (`<section>: unreadable`), or
 * a missing or unreadable string (`unreadable GPP string`). Sections `gpp_sid` doesn't list, and non-US sections, are
 * ignored. Never grants. Never throws.
 */
export function gppSignal(gpp: string | undefined, sids: readonly number[] | undefined): ConsentSignal | undefined {
  const applicable = (sids ?? []).filter(id => US_SECTIONS[id] !== undefined);
  if (applicable.length === 0) return undefined;
  const sections = (gpp ?? '').split('~');
  let ids: readonly number[];
  try {
    ids = gppSectionIds(sections[0] ?? '');
  } catch {
    return { consent: 'denied', reason: 'unreadable GPP string' };
  }
  for (const id of applicable) {
    let reason: string | undefined;
    try {
      const index = ids.indexOf(id);
      reason = sectionReason(id, index < 0 ? undefined : sections[index + 1]);
    } catch {
      reason = `${US_SECTIONS[id]?.[0] ?? ''}: unreadable`;
    }
    if (reason !== undefined) return { consent: 'denied', reason };
  }
  return undefined;
}

/**
 * The `gpp` module: a consent provider that reads the US sections of the request's GPP string (`gpp`, `gpp_sid`). An
 * opt-out denies the SharedID and deletes it, like GPC. Opt-in at build time: not in the built-in list. It has no
 * settings and adds nothing to the payload.
 */
export const gppModule: EdgeModule = defineModule({
  name: 'gpp',
  consent({ consent }: ConsentHookContext): ConsentSignal | undefined {
    return gppSignal(consent.gppString, consent.gppSid);
  },
  run(): undefined {
    return undefined;
  }
});
