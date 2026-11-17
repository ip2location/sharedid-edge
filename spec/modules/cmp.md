# The `cmp` module

Part of the [SharedID Edge specification](../SPEC.md). The general rules for modules, and for [consent providers](../SPEC.md#consent-providers), are there.

Name `cmp`; no `purposes`, no `gvlid`. It is a consent provider: its `consent` hook reads the consent cookie of a consent management platform (CMP) that doesn't write a TCF TC string, for the SharedID's storage decision. It adds nothing to the payload. It is **opt-in at build time**: not among the built-in modules, so a deployment adds it to its build and then lists it in `SID_MODULES`. Its `run`, on `/v1` only, only checks the settings: it reports `empty`, or `error` when they're invalid.

## Settings

`SID_MODULE_CONFIG.cmp` is an object keyed by CMP: `cookiebot`, `onetrust`, `complianz`, `cookieyes`, `iubenda` or `borlabs`, at least one. Each value is an object with, optionally:

- `categories`: a non-empty list of the CMP's category IDs (`^[A-Za-z0-9_.:-]{1,64}$`, no repeats) that cover the SharedID. Default: the CMP's advertising category, `marketing` (Cookiebot, Complianz, Borlabs Cookie), `C0004` (OneTrust), `advertisement` (CookieYes), `5` (iubenda).
- `cookie`: the cookie to read instead of the CMP's default (below): for Complianz, the prefix of its per-category cookies; for iubenda, one exact cookie name starting with `_iub_cs-`.

Anything else (an unknown CMP or key, a wrong type, a cookie name that isn't a valid cookie name) makes the settings invalid. Error messages name the setting, never a configured value. With invalid settings the hook throws, so storage is denied with reason `cmp: error` on every request (see [Consent providers](../SPEC.md#consent-providers)), and `ext.modules.cmp` is `error`.

## Reading a CMP

For each CMP, each listed category is **granted**, **denied** or **unknown**, from the CMP's cookie. A value that can't be read (malformed encoding or JSON, a missing cookie or category, a value other than the ones below) is unknown, never granted. A cookie written before the visitor chose (with the site's defaults), where it can be told apart, is unknown too, so only the visitor's own choice counts:

| CMP | Cookie (default) | Granted / denied | Counts only when |
| --- | --- | --- | --- |
| `cookiebot` | `CookieConsent`: a URL-encoded JavaScript object literal, `{stamp:'…',necessary:true,…,marketing:false,method:'explicit',…}` | `<category>:true` / `<category>:false` | `-1` (outside the regions Cookiebot asks in) is unknown. A grant also needs `method:'explicit'` |
| `onetrust` | `OptanonConsent`: a URL-encoded query string; `groups` is a comma list of `<group>:1` or `<group>:0` | `1` / `0` | the `OptanonAlertBoxClosed` cookie is present and not empty |
| `complianz` | `cmplz_<category>`, else `cmplz_rt_<category>`: `allow` or `deny` | `allow` / `deny` | a grant also needs `<prefix>banner-status` to be `dismissed` |
| `cookieyes` | `cookieyes-consent`: a comma list of `<key>:<value>` | `<category>:yes` / `<category>:no` | it has `action:yes` |
| `iubenda` | every cookie whose name starts with `_iub_cs-`: URL-encoded JSON | `purposes["<id>"]` `true` / `false` | (no condition) |
| `borlabs` | `borlabs-cookie`: URL-encoded JSON with a `consents` object | the group is a list in `consents` / it's missing | `consents` is an object |

A CMP's answer is **denied** when any of its categories is denied (in every cookie read, for iubenda), **granted** when all are granted, and otherwise unknown.

## The signal

The CMPs are read in the order the settings list them. The first that denies gives `{ consent: 'denied', reason: '<cmp>: no consent for <categories, comma-separated>' }`, so `X-SharedID-Status` is, for example, `denied: cmp: cookiebot: no consent for marketing`. Otherwise, if any CMP grants, the signal is `{ consent: 'granted' }`; otherwise there is none. Core's [precedence](../SPEC.md#opt-out-and-consent) then applies: GPC, COPPA and the opt-out cookie first; a denial deletes the ID cookies whether or not GDPR applies and over a TC string; a grant only allows storage where GDPR applies and there's no TC string.

The module MUST NOT keep cookie values or consent beyond the request, and sets, logs and returns nothing.
