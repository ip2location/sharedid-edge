// A tiny GPP encoder for the tests and the conformance cases' strings: the inverse of the module's decoder, written
// from the IAB's Consent String Specification (Global-Privacy-Platform, Core/), not from the decoder.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** An Int(`length`). */
export const int = (value: number, length: number): string => value.toString(2).padStart(length, '0');

/** An Int(Fibonacci): Zeckendorf representation, least significant first (weights 1, 2, 3, 5, …), then `1`. */
export function fibonacci(value: number): string {
  const weights = [1, 2];
  while ((weights.at(-1) ?? 0) + (weights.at(-2) ?? 0) <= value) weights.push((weights.at(-1) ?? 0) + (weights.at(-2) ?? 0));
  const out: string[] = [];
  let rest = value;
  for (let i = weights.length - 1; i >= 0; i--) {
    const weight = weights[i] ?? 0;
    out[i] = weight <= rest ? '1' : '0';
    if (weight <= rest) rest -= weight;
  }
  return out.join('').replace(/0+$/, '') + '1';
}

/** A Range(Fibonacci) of single IDs, in order (each an offset from the last). */
export function range(ids: readonly number[]): string {
  let last = 0;
  return int(ids.length, 12) + ids.map(id => {
    const entry = `0${fibonacci(id - last)}`;
    last = id;
    return entry;
  }).join('');
}

/** Bits as base64url, padded with zeros to a whole number of characters. */
export function base64(bits: string): string {
  const padded = bits.padEnd(Math.ceil(bits.length / 6) * 6, '0');
  let out = '';
  for (let i = 0; i < padded.length; i += 6) out += ALPHABET[parseInt(padded.slice(i, i + 6), 2)] ?? '';
  return out;
}

/** A core subsection: an Int(6) (`Version`, or `MspaVersion`), then Int(2) fields, every one 0 unless set. */
export function core(first: number, count: number, set: Readonly<Record<number, number>> = {}): string {
  let bits = int(first, 6);
  for (let n = 0; n < count; n++) bits += int(set[n] ?? 0, 2);
  return base64(bits);
}

/** A section with a section header (`SectionId`, `Version`, no further subsections) and the core in the same bits. */
export function withHeader(id: number, version: number, mspaVersion: number, count: number, set: Readonly<Record<number, number>> = {}): string {
  let bits = int(id, 6) + int(version, 6) + range([]) + int(mspaVersion, 6);
  for (let n = 0; n < count; n++) bits += int(set[n] ?? 0, 2);
  return base64(bits);
}

/** A whole GPP string: the header listing the sections' IDs, then the sections, joined with `~`. */
export function gpp(sections: readonly (readonly [id: number, section: string])[]): string {
  const header = base64(int(3, 6) + int(1, 6) + range(sections.map(([id]) => id)));
  return [header, ...sections.map(([, section]) => section)].join('~');
}
