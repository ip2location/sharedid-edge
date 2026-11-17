# packages/modules/cmp

User documentation is in [README.md](README.md) (also the npm package page); keep it in step with behaviour changes. The rules for every module are in [`../AGENTS.md`](../AGENTS.md), including [consent providers](../AGENTS.md#consent-providers) and [opt-in modules](../AGENTS.md#opt-in-modules).

The `cmp` module (`@sharedid-edge/module-cmp`): a consent provider that reads the cookies of CMPs without a TCF TC string. See the [spec](../../../spec/modules/cmp.md).

- **Opt-in.** `"optIn": true`; never add it to `builtInModules`: the default builds leave consent providers out (`NO_CONSENT_HOOKS`), so it would be ignored there. It's in the Cloudflare Snippet's `MODULES`, which bundles only what `SID_MODULES` lists.
- **Unknown on doubt, never granted.** Every parser returns `undefined` for a missing cookie, a malformed value, an unexpected value, or a cookie written before the visitor chose (where the CMP marks that). `readCmp` catches anything a parser throws. A refusal counts even where a grant wouldn't (Cookiebot's implied consent, Complianz's `allow` without an answered banner).
- **Formats come from the vendors.** Each parser's format must match the CMP's own documentation, or its published code where the documentation doesn't cover it, cited in the README's "CMP cookie formats". Don't add a CMP, or change a format, from third-party code or observation alone. Use the vendors' example values in tests.
- **Settings fail closed.** `cmpSettings` throws on anything unexpected; the core hook then denies every request (`cmp: error`). Messages name settings, never values.
- **ECMAScript only:** no `URLSearchParams` or other web globals beyond what core uses (EdgeWorkers lacks them; the Akamai bundle shims only what core needs). `decodeURIComponent` and `JSON.parse` are fine.
- **Nothing kept, logged or returned:** no cookie values in reasons (only CMP and category names from the settings).
- **Tests:** `test/cmp.test.ts` covers the settings, each CMP's granted, refused, pre-choice and malformed values, combining CMPs and categories, and the module through core's handler (precedence over GPC, TC strings, GDPR). Conformance: `conformance/cases/module-cmp.json` and `module-cmp-invalid-config.json` (the opt-in build).
