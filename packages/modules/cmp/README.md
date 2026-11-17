# @sharedid-edge/module-cmp

The `cmp` module for [SharedID Edge](../../../README.md): consent for the SharedID from the cookie of a consent management platform (CMP) that doesn't write a TCF TC string: **Cookiebot, OneTrust, Complianz, CookieYes, iubenda and Borlabs Cookie**.

The worker's own consent check reads one CMP format, the TCF TC string (`gdpr_consent`, or the `euconsent-v2` cookie). Many sites, especially on WordPress, use a CMP that writes no TC string, or have TCF turned off in Cookiebot or OneTrust. For them:

- **where GDPR applies,** there's never a TC string, so the worker denies the SharedID to every visitor, including those who accepted;
- **elsewhere,** the worker can't see that a visitor declined, so it sets the ID anyway.

This module reads the CMP's own cookie and tells the worker what the visitor chose. It's a **consent provider** (see [Consent providers](../../../spec/SPEC.md#consent-providers)): it adds nothing to the payload, and only changes the storage decision.

**It's opt-in at build time.** Unlike the built-in modules, it isn't in the default builds: you add it to yours (below), then list it in `SID_MODULES`. The default builds don't carry it, nor the code in core that runs it.

## Contents

- [Turning it on](#turning-it-on)
- [Settings](#settings)
- [Consent rules](#consent-rules)
- [Responses](#responses)
- [CMP cookie formats](#cmp-cookie-formats)
- [Size](#size)
- [Using it in code](#using-it-in-code)
- [Troubleshooting](#troubleshooting)

## Turning it on

1. **Add it to your build,** as `@sharedid-edge/module-cmp#cmpModule`:

   | Platform | Build |
   | --- | --- |
   | Cloudflare Worker | In `packages/adapters/cloudflare`: `node ../../../scripts/module-list.mjs .sharedid-modules --worker --module @sharedid-edge/module-cmp#cmpModule`, then `npx wrangler deploy .sharedid-modules/worker.ts` in place of `npm run deploy`. Don't add it to `src/index.ts` and use `npm run deploy`: that build leaves consent providers out. |
   | Cloudflare Snippet | Nothing to add: the Snippet bundles the modules `SID_MODULES` lists, `cmp` included. See the [Snippet section](../../adapters/cloudflare/README.md#worker-or-snippet). |
   | AWS Lambda, Vercel, Azure Functions, Google Cloud, Akamai, Fastly | `npm run bundle -w @sharedid-edge/<adapter> -- --module @sharedid-edge/module-cmp#cmpModule` in place of `npm run bundle` (Fastly: then `npm run wasm`). |
   | Node.js | `SID_MODULE_PACKAGES=@sharedid-edge/module-cmp#cmpModule`, with the package installed next to the server. |

2. **Name your CMP** and, if it isn't the default, the category that covers the SharedID (an advertising ID). In `wrangler.jsonc`, or your platform's settings:

   ```jsonc
   "vars": {
     "SID_MODULES": "cmp",                                   // with others: "cmp,reflect"
     "SID_MODULE_CONFIG": "{\"cmp\":{\"cookiebot\":{}}}"     // Cookiebot, category "marketing"
   }
   ```

   Other examples:

   ```jsonc
   {"cmp":{"onetrust":{"categories":["C0004"]}}}               // OneTrust: your Targeting group's ID
   {"cmp":{"complianz":{}}}                                     // Complianz: cmplz_marketing
   {"cmp":{"cookieyes":{"categories":["advertisement"]}}}       // CookieYes
   {"cmp":{"iubenda":{"categories":["5"]}}}                     // iubenda: purpose 5, marketing
   {"cmp":{"borlabs":{"categories":["marketing"]}}}             // Borlabs Cookie: the group ID
   ```

3. **Check** with a browser that has accepted and one that has declined, from a GDPR country or with `?gdpr=1`:

   ```sh
   curl -sI 'https://www.example.com/_sid/sync?gdpr=1' -H 'Cookie: cookieyes-consent=consentid:x,consent:yes,action:yes,advertisement:no' | grep -i x-sharedid-status
   # x-sharedid-status: denied: cmp: cookieyes: no consent for advertisement
   ```

## Settings

`SID_MODULE_CONFIG.cmp` is an object keyed by CMP. List the one your site uses (more than one only while you move between CMPs):

| CMP | Key | Default `categories` | Default `cookie` |
| --- | --- | --- | --- |
| Cookiebot | `cookiebot` | `["marketing"]` | `CookieConsent` |
| OneTrust | `onetrust` | `["C0004"]` (Targeting Cookies) | `OptanonConsent` |
| Complianz | `complianz` | `["marketing"]` | prefix `cmplz_`, then `cmplz_rt_` (a multisite's root) |
| CookieYes | `cookieyes` | `["advertisement"]` | `cookieyes-consent` |
| iubenda | `iubenda` | `["5"]` (Marketing) | every `_iub_cs-…` cookie |
| Borlabs Cookie | `borlabs` | `["marketing"]` | `borlabs-cookie` |

Each CMP's entry is an object with, optionally:

- **`categories`:** the CMP's categories (OneTrust group IDs, iubenda purpose IDs, Borlabs group IDs) that cover the SharedID. **All** must be granted for a grant; **any** denied is a denial. Category IDs are per site in OneTrust, CookieYes and Borlabs Cookie: check yours in the CMP's dashboard, or in the cookie (see [CMP cookie formats](#cmp-cookie-formats)).
- **`cookie`:** a different cookie name. For Complianz it's the prefix of the per-category cookies; for iubenda, one exact cookie name (`_iub_cs-s1234567`), when the domain has several iubenda sites.

Settings are checked strictly: an unknown CMP or key, an empty or repeated category, or a cookie name that isn't one is **invalid**. Invalid settings fail closed: every request is denied (`X-SharedID-Status: denied: cmp: error`, and existing IDs are deleted), and `ext.modules.cmp` is `error`, so a typo can't let IDs through. A Snippet build with invalid settings fails, with the reason.

## Consent rules

In order, as the [specification](../../../spec/SPEC.md#opt-out-and-consent) has them:

1. **The opt-out cookie, Global Privacy Control and COPPA** deny first, as always. The CMP cookie can't change that.
2. **A refusal in the CMP cookie denies** the SharedID and deletes the ID cookies, whether or not GDPR applies, and even when there's a TC string that allows it. A visitor who said no to your CMP is honoured everywhere.
3. **A TC string, when there is one,** decides as today. A grant in the CMP cookie doesn't override a TC string that denies, or one that isn't valid.
4. **A grant in the CMP cookie allows** the SharedID where GDPR applies and there's no TC string. That's the only case where the module allows something the worker would otherwise deny.
5. **No answer** (no cookie, no choice yet, a value the module can't read): nothing changes. Denied where GDPR applies, allowed elsewhere.

A cookie the CMP writes **before** the visitor chooses isn't the visitor's answer, and is ignored where the CMP marks it (OneTrust, CookieYes, Complianz, Cookiebot's implied consent; see the formats below).

This only decides the SharedID (and what `reflect` and other modules see as `storage`). It doesn't change the other consent rules: modules that declare TCF `purposes` still need a TC string where GDPR applies, and so does precise location (`ip`, `geo`).

## Responses

The module adds nothing to the payload. On `/_sid/v1` it reports `empty`, or `error` with invalid settings:

```json
{
  "v": 1,
  "sharedid": "c29cb2ae-769d-42f6-891a-f53cadee823d",
  "eids": [{ "source": "pubcid.org", "uids": [{ "id": "c29cb2ae-769d-42f6-891a-f53cadee823d", "atype": 1 }] }],
  "ext": { "modules": { "cmp": { "ms": 0, "status": "empty" } } }
}
```

Its effect is on the storage decision, in `X-SharedID-Status` on `/_sid/sync` and `/_sid/v1`:

| The CMP cookie says | GDPR applies, no TC string | GDPR doesn't apply |
| --- | --- | --- |
| granted | ID set (no status header) | ID set |
| refused | `denied: cmp: <cmp>: no consent for <categories>`, ID deleted | the same |
| nothing (no cookie, no choice yet, unreadable) | `denied: tcf: GDPR applies and there is no TC string` | ID set |

## CMP cookie formats

How each CMP's cookie is read, and where its format is documented. Where the vendor's documentation doesn't spell the format out, the details come from the vendor's own published code, marked as such. CMP formats change between versions: anything the module doesn't recognise is no answer, never a grant.

### Cookiebot

- **Cookie:** `CookieConsent`, a JavaScript object literal (not JSON), URL-encoded: `{stamp:'…',necessary:true,preferences:false,statistics:true,marketing:false,ver:1,utc:1646127963403}`.
- **Read as:** `<category>:true` granted, `<category>:false` refused, as Cookiebot's own server-side examples read the cookie. The value `-1` ("The user is not within a region that requires consent - all cookies are accepted"), and a `stamp` of `'-1'` as in Cookiebot's published example, are no answer: the worker's own location rules apply. A cookie with `method:'implied'` (Cookiebot: "when a consent is given automatically") grants nothing, though a refusal in it counts.
- **Sources:** Cookiebot's [developer documentation](https://www.cookiebot.com/en/developer/) (the server-side PHP and ASP.NET examples reading `CookieConsent`, the `-1` value, and `consent.method`), its [API article](https://support.cookiebot.com/hc/en-us/articles/360006346473-Extracting-cookie-information-via-API) (an example value) and the [Cookiebot SDK reference](https://usercentrics.com/docs/web/cookiebot/cookiebot-sdk). The documentation doesn't say whether `method` is in the cookie; when it is and says `'implied'`, the module is stricter than Cookiebot's examples.

### OneTrust

- **Cookie:** `OptanonConsent`, a URL-encoded query string; its `groups` is a comma list of `<group ID>:1` (consent) or `:0` (no consent), such as `groups=C0001:1,C0002:0,C0003:1,C0004:0`.
- **Read as:** `1` granted, `0` refused, only once `OptanonAlertBoxClosed` is set. OneTrust writes `OptanonConsent` with the site's default groups before any choice (`interactionCount=0`), and sets `OptanonAlertBoxClosed` when the visitor accepts, rejects, saves or closes the banner.
- **Groups:** OneTrust's defaults include `C0002` (Performance), `C0003` (Functional) and `C0004` (Targeting); a site can add and rename groups, so check yours.
- **Sources:** OneTrust's [OneTrust Cookies](https://my.onetrust.com/articles/en_US/Knowledge/UUID-2dc719a8-4be5-8d16-1dc8-c7b4147b88e0) (the `OptanonConsent` fields, `groups`, `interactionCount`, `OptanonAlertBoxClosed`), [Client-Side Cookie Management](https://my.onetrust.com/articles/en_US/Knowledge/UUID-518074a1-a6da-81c3-be52-bae7685d9c94) (the category IDs) and the [JavaScript API](https://developer.onetrust.com/onetrust/docs/javascript-api).

### Complianz

- **Cookies:** one per category, `cmplz_marketing`, `cmplz_statistics`, `cmplz_preferences`, `cmplz_functional`, each `allow` or `deny`; on a multisite's root the prefix is `cmplz_rt_`. `cmplz_banner-status` is `dismissed` once the banner was answered.
- **Read as:** `deny` refused; `allow` granted only with `cmplz_banner-status=dismissed`. In regions where the site shows no banner, Complianz writes `allow` by itself, so `allow` alone isn't the visitor's choice. Make sure your Complianz regions show a banner in every GDPR country (the EU, the rest of the EEA, the UK and Turkey).
- **Sources:** Complianz's [developers' guide for third-party integrations](https://complianz.io/developers-guide-for-third-party-integrations/) (the cookies, `allow`, `deny`, the `cmplz_rt_` prefix). Complianz recommends its JavaScript API over reading the cookies; this module has only the cookies. The automatic `allow` is from the plugin's [published code](https://github.com/complianz/complianz-gdpr).

### CookieYes

- **Cookie:** `cookieyes-consent`, a comma list of `<key>:<value>`: `consentid:…,consent:yes,action:yes,necessary:yes,functional:no,analytics:no,performance:no,advertisement:no`.
- **Read as:** `<category>:yes` granted, `:no` refused, only with `action:yes`. Before a choice, CookieYes writes the cookie with the defaults and an empty `action`. `consent` isn't read: it's `no` only for "Reject all".
- **Sources:** CookieYes's [Obtain the consent ID](https://www.cookieyes.com/documentation/obtain-the-consent-id/) and [getCkyConsent](https://www.cookieyes.com/documentation/retrieving-consent-data-using-api-getckyconsent/) documentation (the cookie, and the consent and action states). The value's layout is from CookieYes's [published plugin code](https://plugins.svn.wordpress.org/cookie-law-info/trunk/lite/frontend/js/script.js).

### iubenda

- **Cookie:** `_iub_cs-s<site ID>` (or `_iub_cs-<cookie policy ID>`), URL-encoded JSON with `purposes`, purpose ID to `true` or `false`, when per-category consent is on.
- **Read as:** `true` granted, `false` refused. Purposes: 1 Necessary, 2 Functionality, 3 Experience, 4 Measurement, 5 Marketing. Every `_iub_cs-` cookie is read, and they must agree (a refusal in any is a refusal); `cookie` picks one. Without `purposes` (per-category consent off), it's no answer. iubenda can record consent from scrolling or continued browsing, and the cookie doesn't say which: if you turn that on, the worker counts it as a grant.
- **Sources:** iubenda's [advanced configuration guide](https://www.iubenda.com/en/help/1205-how-to-configure-your-cookie-solution-advanced-guide) (purpose IDs, `perPurposeConsent`) and [changelog](https://www.iubenda.com/en/help/1970-cookie-solution-changelog) (cookies per site ID; with `storage.autoSync` the choice may be in local storage only, which the worker can't see). The JSON's `purposes` field is from iubenda's [published cookie class](https://github.com/iubenda/iubenda-cookie-class/blob/master/iubenda.class.php).

### Borlabs Cookie

- **Cookie:** `borlabs-cookie`, URL-encoded JSON: `{"consents":{"essential":["borlabs-cookie"],"marketing":["google-ads"]},"domainPath":"example.com/","expires":"…","uid":"…","v3":true,"version":1}` (Borlabs Cookie 3; version 2 has the same `consents`).
- **Read as:** a group listed in `consents` granted; a group that's missing refused. Borlabs writes the cookie only when the visitor saves a choice, and lists only the groups accepted.
- **Groups:** `essential`, `statistics`, `marketing`, `external-media` by default; a site can add groups.
- **Sources:** Borlabs's [JavaScript API](https://borlabs.io/kb/javascript-api-v3/) documents consent per service group, not the cookie's layout. The layout is from the plugin's published JavaScript (served from borlabs.io with the plugin). This is the least documented of the six: check it against your site's cookie before relying on it.

### Not supported

CMPs that keep the choice only in the page's local storage (Usercentrics' newer versions, iubenda with `storage.autoSync`) can't be read by the worker, which only sees cookies. Didomi, Axeptio and Ketch aren't read yet. A CMP that can write a TCF TC string is better read that way: turn TCF on and the worker reads `euconsent-v2` without this module.

## Size

Measured with this repository's build:

- **The module:** 4.0 KB minified, 1.7 KB gzipped.
- **A Lambda bundle with it:** 1.5 KB more gzipped than the default bundle (the module, and core's consent-provider code, which default builds leave out).
- **A Snippet** with `SID_MODULES: "cmp"` (Cookiebot): 22.0 KB minified, 3.4 KB more than core alone, of the Snippet's 32 KB.

Your build reports its own size: `npm run bundle` prints the gzipped size, and the Snippet build its size by part.

## Using it in code

```ts
import { createHandler, resolveConfig } from '@sharedid-edge/core';
import { builtInModules } from '@sharedid-edge/modules';
import { cmpModule, cmpSettings, cmpSignal } from '@sharedid-edge/module-cmp';

const handler = createHandler({ config: resolveConfig(env), modules: [...builtInModules, cmpModule] });

// The parsers on their own: { consent: 'granted' }, { consent: 'denied', reason }, or undefined.
const signal = cmpSignal(new Map([['cmplz_marketing', 'deny']]), cmpSettings({ complianz: {} }));
```

## Troubleshooting

- **`ext.modules.cmp` is `skipped`, `not installed`:** your build doesn't have the module. Add it (step 1), and check you deployed that build.
- **Every request says `denied: cmp: error`:** the settings are invalid. `ext.modules.cmp` is `error` too. Check `SID_MODULE_CONFIG.cmp` against [Settings](#settings).
- **Visitors who accepted still get `denied: tcf: GDPR applies and there is no TC string`:** the module found no answer. Check the cookie reaches the worker (it must be on the worker's domain and path, not only in local storage), the category ID matches your CMP's (OneTrust and Borlabs IDs vary by site), and the CMP's "choice made" marker (OneTrust's `OptanonAlertBoxClosed`, CookieYes's `action:yes`, Complianz's `cmplz_banner-status`; for Cookiebot, not `method:'implied'`).
- **Visitors outside the EU are denied with `cmp: …`:** they refused in your CMP. That's intended: a refusal is honoured everywhere.
- **A TC string is present:** with Cookiebot or OneTrust in TCF mode, the TC string decides grants; the module's refusals still apply.
