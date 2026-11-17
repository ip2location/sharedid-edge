# The `gpp` module

Part of the [SharedID Edge specification](../SPEC.md). The general rules for modules, and for [consent providers](../SPEC.md#consent-providers), are there.

Name `gpp`; no `purposes`, no `gvlid`, no settings. It is a consent provider: its `consent` hook reads the US sections of the request's [IAB Global Privacy Platform](https://github.com/InteractiveAdvertisingBureau/Global-Privacy-Platform) (GPP) string for the SharedID's storage decision. It adds nothing to the payload. It is **opt-in at build time**: not among the built-in modules, so a deployment adds it to its build and then lists it in `SID_MODULES`. Its `run`, on `/v1` only, does nothing and reports `empty`.

## Inputs

The `gpp` query parameter (the GPP string) and `gpp_sid` (the comma-separated IDs of the sections that apply), as core reads them (see [Consent](../SPEC.md#consent)): `gpp_sid` entries that aren't digits are dropped. Nothing else: the GPP specification leaves where a CMP stores the string to the CMP ("The storage mechanism used for GPP Strings is up to a CMP", Consent String Specification, "How should the GPP String be stored?"), so there is no standard cookie to read.

## Applicable sections

A section applies when `gpp_sid` lists it and it is one of the **US sections** of the IAB's [section list](https://github.com/InteractiveAdvertisingBureau/Global-Privacy-Platform/blob/main/Sections/Section%20Information.md), IDs 7 to 27:

| ID | Section | ID | Section | ID | Section |
| --- | --- | --- | --- | --- | --- |
| 7 | `usnat` (US National) | 14 | `usmt` (Montana) | 21 | `usnj` (New Jersey) |
| 8 | `usca` (California) | 15 | `usor` (Oregon) | 22 | `ustn` (Tennessee) |
| 9 | `usva` (Virginia) | 16 | `ustx` (Texas) | 23 | `usmn` (Minnesota) |
| 10 | `usco` (Colorado) | 17 | `usde` (Delaware) | 24 | `usmd` (Maryland) |
| 11 | `usut` (Utah) | 18 | `usia` (Iowa) | 25 | `usin` (Indiana) |
| 12 | `usct` (Connecticut) | 19 | `usne` (Nebraska) | 26 | `usky` (Kentucky) |
| 13 | `usfl` (Florida) | 20 | `usnh` (New Hampshire) | 27 | `usri` (Rhode Island) |

Other sections (TCF EU, TCF Canada, `uspv1`, IDs the list doesn't have yet) are ignored, as are US sections the string has but `gpp_sid` doesn't list. When `gpp_sid` lists no US section, the string isn't read at all, and the module has no signal.

## Decoding

Per the IAB's [Consent String Specification](https://github.com/InteractiveAdvertisingBureau/Global-Privacy-Platform/blob/main/Core/Consent%20String%20Specification.md):

- The string is sections joined with `~`; the first is the **header**, then one section per ID in the header's list, in its order. A section may have subsections joined with `.`.
- Each part is **base64url** (`A`–`Z`, `a`–`z`, `0`–`9`, `-`, `_`; six bits per character, most significant first), zero-padded at the end.
- **Header:** `Type` Int(6) = 3, `Version` Int(6) = 1, then `Sections`, a **Range (Fibonacci)**: Int(12) entries, each a Boolean (0 a single ID, 1 a group) and an Int(Fibonacci) offset from the last ID read (0 at first), plus for a group an Int(Fibonacci) length (the group runs from its first ID to first ID + length).
- **Int(Fibonacci):** bits weighted 1, 2, 3, 5, 8, … from the first, ended by the first `11` (whose first `1` is the last weighted bit).

Each US section's **core subsection** is read for the fields below; nothing else is. Every field read is an Int(2): 0 not applicable, 1 opted out (for the known-child fields, no consent), 2 did not opt out (consent). `N-Bitfield(2,x)` fields are x Int(2) in a row. The positions are those of each section's technical specification (`Sections/US-National`, `Sections/US-States/<state>` in the IAB repository); a field `n` places after the first Int(6) is at bit `6 + 2n`:

| Section | First Int(6) | Sale opt-out | Sharing opt-out | Targeted advertising opt-out | Known-child fields |
| --- | --- | --- | --- | --- | --- |
| `usnat` v1 | `Version` = 1 | 6 | 7 | 8 | 21–22 |
| `usnat` v2 | `Version` = 2 | 6 | 7 | 8 | 25–27 |
| `usca` | `Version` = 1 | 3 | 4 | | 14–15 |
| `usva`, `ustx`, `usne`, `ustn`, `usmn` | `Version` = 1 | 3 | | 4 | 13 |
| `usco` | `Version` = 1 | 3 | | 4 | 12 |
| `usut`, `usia` | `Version` = 1 | 4 | | 5 | 14 |
| `usct`, `usfl`, `usmt`, `usnh` | `Version` = 1 | 3 | | 4 | 13–15 |
| `usor` | `Version` = 1 | 3 | | 4 | 16–18 |
| `usde` | `Version` = 1 | 3 | | 4 | 14–18 |
| `usnj` | `Version` = 1 | 3 | | 4 | 15–19 |
| `usmd` | `MspaVersion` | 5 | | 6 | (none) |
| `usin`, `usky`, `usri` | `MspaVersion` | 5 | | 6 | 7 |

**US National version 3** (November 2026, the Fifth Amended and Restated MSPA) has a single opt-out: its core subsection is `MspaVersion` Int(6), `MspaNotice` Int(2), `MspaOptOut` Int(2) (1: the consumer opted out), `MspaId` Int(14), so `MspaOptOut` is field 1.

**Section headers.** US National version 3 and the Maryland, Indiana, Kentucky and Rhode Island sections specify a section header before the core subsection: `SectionId` Int(6) (the section's own ID), `Version` Int(6), and `SubSections`, a Range (Fibonacci) of the subsections after the core. The specification doesn't say whether the core follows in the same bits or as the next `.` subsection, so both are read, told apart by the count: the core follows in the same bits when there is one `.` part more than `SubSections` lists, and is the next part when there are two more; any other count is unreadable. The IAB's reference library ([iabgpp-es](https://github.com/IABTechLab/iabgpp-es)) writes the four state sections without the section header, starting at `MspaVersion`; that form is read too. The forms are told apart by the first Int(6): a section header's is the section's ID (7, 24 to 27); a `Version` or `MspaVersion` is never one of those.

A section is **unreadable** when: the string has no header, or the header isn't valid (`Type` or `Version` wrong, a character outside base64url, a range that runs out of bits or names an ID over 999); the header doesn't list the section, or its part is missing or empty; its version isn't one in the table (`Version` 1, or 1 and 2 for `usnat`; a section header's `Version` 3 for `usnat` and 1 for the four states); a field read is past the end of its bits, or is 3.

## The rule

For the applicable sections in `gpp_sid` order:

1. a section that is unreadable denies, with reason `<section>: unreadable` (`unreadable GPP string` when the header can't be read, or there is no `gpp` at all);
2. a section with a sale, sharing or targeted advertising opt-out of 1 denies, with reason `<section>: opted out of sale`, `… of sharing` or `… of targeted advertising`, read in that order (US National version 3: `usnat: opted out`);
3. a section with any known-child field of 1 (no consent) denies, with reason `<section>: no consent for a known child`.

The first denial is the module's signal, `{ consent: 'denied', reason }`, so `X-SharedID-Status` is, for example, `denied: gpp: usnat: opted out of sale`. Otherwise there is no signal: the module **never grants**. Core's [precedence](../SPEC.md#opt-out-and-consent) then applies: GPC, COPPA and the opt-out cookie come first; the denial deletes the ID cookies, whether or not GDPR applies and over a TC string; with no signal nothing changes.

**Why an unreadable string denies.** When `gpp_sid` says a US section applies, the string is the visitor's US opt-out signal, and a string the module can't read may carry an opt-out it can't see. The module treats it as GPC treats a browser that says it opted out: no ID. A section version the IAB publishes after the module's is unreadable too, until the module learns it. This can only deny, never allow, so it can't weaken any other signal.

**Not read:** the notices, the sensitive-data fields, `PersonalDataConsents`, `AdditionalDataProcessingConsent`, the MSPA fields other than US National version 3's `MspaOptOut`, and the GPC subsection (GPC reaches the worker as the `Sec-GPC` header, which core reads).

The module MUST NOT keep the string or anything decoded from it beyond the request, and sets, logs and returns nothing.
