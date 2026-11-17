# packages/modules/gpp

User documentation is in [README.md](README.md) (also the npm package page); keep it in step with behaviour changes. The rules for every module are in [`../AGENTS.md`](../AGENTS.md), including [consent providers](../AGENTS.md#consent-providers) and [opt-in modules](../AGENTS.md#opt-in-modules).

The `gpp` module (`@sharedid-edge/module-gpp`): a consent provider that decodes the US sections of the request's GPP string (`gpp`, `gpp_sid`). See the [spec](../../../spec/modules/gpp.md).

- **Opt-in.** `"optIn": true`; never add it to `builtInModules`: the default builds leave consent providers out (`NO_CONSENT_HOOKS`), so it would be ignored there. It's in the Cloudflare Snippet's `MODULES`, which bundles only what `SID_MODULES` lists. No settings, so no parser.
- **Denies, never grants.** An opt-out, a known child without consent, or a US section `gpp_sid` names that can't be read, denies; otherwise nothing. Don't add a grant: GPP has no "consented to storage" signal that could lift a GDPR denial.
- **Fail closed, without throwing.** Everything that can't be read throws a `RangeError` inside the decoder, which `gppSignal` catches and turns into an `unreadable` denial. Don't let the hook throw (core would report `gpp: error`, the same outcome but a worse reason), and never turn an unreadable section into "no opt-out".
- **Layouts come from the IAB.** Every position in `US_SECTIONS` must match the section's technical specification in [Global-Privacy-Platform](https://github.com/InteractiveAdvertisingBureau/Global-Privacy-Platform) (`Sections/`), cited in the spec's table. A new section or version: add its layout from the IAB's document, the spec table and README rows, a unit test, and check it against the IAB's reference library ([iabgpp-es](https://github.com/IABTechLab/iabgpp-es)) where it supports the section. Unknown versions stay unreadable.
- **Small.** Decode only the header and the fields read; no general GPP decoder, no runtime dependency.
- **Nothing kept, logged or returned:** reasons hold only section names, never string content.
- **Tests:** `test/gpp.test.ts` (the IAB's header examples, each layout, the section-header forms, unreadable strings, `gpp_sid` filtering, and the module through core's handler: precedence over a TC string, never over GPC, COPPA, opt-out or GDPR). `test/encode.ts` is a small encoder for test strings. Conformance: `conformance/cases/module-gpp.json` (the opt-in build), with strings from the IAB's reference library and the specification's examples.
