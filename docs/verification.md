# How SharedID Edge is verified

Every way of deploying SharedID Edge is checked somehow, but not all in the same way. The Cloudflare Worker is deployed to a real Cloudflare zone and tested there after every merge, while the Akamai EdgeWorker has only run behind this project's own stand-in for Akamai. This page says, for every deployment in the adapter READMEs and the [hosting-company](hosting-companies.md) and [upstream-operator](upstream-operators.md) guides, how it has been verified, what that proves, and where to look at the results yourself.

This page is the overall picture. The guides' "What's been verified live" sections keep the details of each live run, and link here.

## Contents

- [The verification levels](#the-verification-levels)
- [The matrix](#the-matrix)
  - [Each platform's own deployment](#each-platforms-own-deployment)
  - [Upstream-operator endpoints](#upstream-operator-endpoints)
  - [Publisher CDN recipes](#publisher-cdn-recipes)
  - [Hosting-company models](#hosting-company-models)
  - [Opt-in and vendor modules](#opt-in-and-vendor-modules)
  - [Counts](#counts)
- [The behaviour that must not regress](#the-behaviour-that-must-not-regress)
- [The verification workflows](#the-verification-workflows)
  - [CI, on every pull request](#ci-on-every-pull-request)
  - [Live tests (Cloudflare)](#live-tests-cloudflare)
  - [Live tests (AWS)](#live-tests-aws)
  - [Live tests (upstream operator)](#live-tests-upstream-operator)
  - [The upstream-operator and Cloudflare for SaaS live setups](#the-upstream-operator-and-cloudflare-for-saas-live-setups)
  - [The website workflow](#the-website-workflow)
- [What the checks assert](#what-the-checks-assert)
  - [verify-deployment](#verify-deployment)
  - [check-cloudfront](#check-cloudfront)
  - [check-live-site](#check-live-site)
  - [The conformance suite](#the-conformance-suite)
  - [The browser tests](#the-browser-tests)
- [Not verified yet](#not-verified-yet)
- [Verifying your own deployment](#verifying-your-own-deployment)

## The verification levels

Each deployment below has one of five levels, the highest it has reached **as a whole**, set up as its guide says. When parts of a deployment have been checked at a higher level than the whole (the handler emulated, say, but the CDN rule in front of it only written from the vendor's documentation), the table gives the lower level and lists the parts in its evidence.

| Level | What it is | What it proves | What it can't prove |
| --- | --- | --- | --- |
| **1. Live, automated** | A GitHub Actions workflow deploys to real infrastructure in this project's own account and tests it there, on every merge to `main`, nightly and on demand. The run history is public. | That the deployment steps work. Also the platform's real routing and headers (`request.cf`, the visitor's address and location), TLS, the real runtime, that the endpoint shares the site's IP addresses (Safari's rule), the CDN not caching responses, and unmodified Prebid.js on a page from the same hostname in three browser engines. It keeps proving it: a change on the platform's side, or a new browser version, fails the nightly run. | Anything outside the test's vantage point. The runs come from GitHub's runners in the US, so there's no EU visitor and no GDPR decided by a real visitor's country. Only one configuration per deployment is tested (the default, and the browser tests' settings), the test zone is on Cloudflare's Free plan (no Bot Management, no Snippets), and real Safari isn't in the live runs. |
| **2. Live, manual** | Someone ran the project's scripts against real infrastructure by hand, and the result is recorded with its date in an issue, a pull request or a guide. | The same as level 1, for that configuration, on that date. | That it still works: nothing re-runs it. A platform change since the recorded date isn't caught. The same vantage-point limits as level 1 apply. |
| **3. Emulated** | The real build runs in the vendor's own local runtime or official emulator: the Worker in workerd through `wrangler dev`, the compiled Fastly package in Viceroy, or the Lambda bundle on AWS Emulator. In CI or locally, with no account. | That the bundle the deployment uses actually runs in that runtime: its APIs, globals, module format, size limits and cookie handling. It runs the whole conformance suite, every configuration, including cases a live run can't set up (an EU location, IPv6 clients, forged headers, other settings). | The platform's network edge. The runtime is real, but the visitor's address and location are fed in by the test, not by the platform. Its real header behaviour, TLS, IP-address sharing with the site, caching, and the deployment steps themselves aren't exercised. |
| **4. Simulated** | The handler runs behind this project's own stand-in for the platform (`conformance/src/*-emulator.ts`), which converts HTTP requests to the platform's event or request shape and the response back, plus unit tests with requests shaped as the platform delivers them. | That the adapter maps requests and responses as the platform's documentation describes: the client IP and location headers it reads, how cookies leave it, its routes, and the settings it refuses. The whole conformance suite passes, with the platform's known gaps listed. | That the platform behaves as documented. The stand-in was written from the same documentation as the adapter, so a misreading in both passes. Nothing proves the real headers, the real runtime (for the stand-ins that aren't the vendor's code), the visitor's real address and location, TLS, IP sharing (Safari's same-IP rule), caching or the deployment steps. |
| **5. Documented only** | A configuration written from the vendor's documentation, not run in any of the ways above. | Nothing beyond review. | Anything. Check it with [Verifying your own deployment](#verifying-your-own-deployment) before relying on it. |

Static checks don't raise a level on their own: CI lints the AWS templates with `cfn-lint`, builds the Azure Bicep templates and validates the Google Cloud Terraform, all without an account. They catch syntax and schema errors, not whether the platform accepts the template or behaves as expected.

## The matrix

Paths are in this repository. "Live tests" means the [Cloudflare](#live-tests-cloudflare), [AWS](#live-tests-aws) or [upstream-operator](#live-tests-upstream-operator) workflow below, and "upstream-operator live setup" the [manual scripts](#the-upstream-operator-and-cloudflare-for-saas-live-setups) the upstream-operator workflow runs. That workflow first ran green on 17 November 2026 ([run](https://github.com/patmmccann/sharedid-edge/actions/runs/44018521159)); its CloudFront publisher isn't set up yet, so that recipe stays at level 2. Every row's simulated and emulated checks run on every pull request in [`ci.yml`](../.github/workflows/ci.yml) unless the row says otherwise.

### Each platform's own deployment

SharedID Edge on the platform that serves the site, on its own hostname (the upstream-operator guide's model A).

| Deployment | Level | Evidence | Not proven |
| --- | --- | --- | --- |
| **Cloudflare Worker**, on a route of the site's proxied hostname | **1. Live, automated** | [`e2e-cloudflare.yml`](../.github/workflows/e2e-cloudflare.yml) on `e2e.sharedid.dev` and `conformance.sharedid.dev`: `verify-deployment`, the 26 default-configuration conformance cases, and the 14 browser tests in Chromium, Firefox and WebKit. Emulated: the full conformance suite in workerd (`npm run conformance:wrangler`, the `conformance-workerd` job) and the unit tests, which run inside workerd. | An EU visitor; the CORS and route cases (`routes.json`), forged headers and modules other than `reflect` and `clickid`, which run in workerd but not live; real Safari; Bot Management. |
| **Cloudflare Snippet** | **4. Simulated** | `npm run test:snippet -w @sharedid-edge/cloudflare`: the Snippet bundle and the Worker, both in Node.js with `request.cf` supplied by the test, answer every buildable conformance case file identically, and invalid settings fail the Snippet's build. `npm run build:snippet` checks the 32 KB limit and smoke-tests the bundle; CI builds the example configuration. The Worker it shares its handler with is live (above). | That Cloudflare accepts the file at its size, that the snippet rule routes only the base path, `request.cf` in a Snippet, the 5 ms CPU limit in practice. A live test needs a Pro zone: [#105](https://github.com/patmmccann/sharedid-edge/issues/105). |
| **AWS Lambda and CloudFront**, a behaviour on the site's distribution | **1. Live, automated** | [`e2e-aws.yml`](../.github/workflows/e2e-aws.yml), the [AWS live tests](#live-tests-aws), on a real distribution's `*.cloudfront.net` hostname: `verify-deployment`, `check-cloudfront` (11 checks), the 26 default-configuration conformance cases, and the 14 browser tests in Chromium, Firefox and WebKit. First green run on 17 November 2026 ([run](https://github.com/patmmccann/sharedid-edge/actions/runs/44015773690)). The same steps run by hand on 12 November 2026 ([#141](https://github.com/patmmccann/sharedid-edge/pull/141)) found and fixed a bug no local target could see (`clickid` behind origin access control). Emulated: the full suite on AWS Emulator (`conformance:lambda-aws-emulator`, a CI job not required yet), with its limitations listed. Simulated: `conformance:lambda`, behind `conformance/src/lambda-emulator.ts`. Static: `cfn-lint` on `template.yaml` and `live/site.yaml`. | An EU visitor; real Safari; the conformance cases with other settings than the default (routes, consent modes, modules), which run on AWS Emulator but not live. Not run on a site's own domain, or with the template's `CreateDistribution=true` as a site's distribution. |
| **Fastly Compute** | **3. Emulated** | `npm run conformance:fastly` and `conformance:fastly:reusable` (the `conformance-fastly` jobs): the compiled package in Viceroy, the full suite, plus `conformance/src/fastly-checks.ts` (forged `X-Forwarded-For` and `Fastly-Client-IP` change nothing, one `Set-Cookie` per cookie, `Cache-Control`, nothing of one visitor reaches the next in a reused sandbox). | Everything in the adapter's [What isn't confirmed](../packages/adapters/fastly/README.md#what-isnt-confirmed): never on a live Fastly service. |
| **Akamai EdgeWorkers** | **4. Simulated** | `npm run conformance:akamai`: the bundle in a V8 context without web or Node.js globals, behind `conformance/src/akamai-emulator.ts`, the full suite, plus `conformance/src/akamai-checks.ts` (it distrusts `X-Forwarded-For`, `Cache-Control` on every response). | The adapter's [What isn't confirmed](../packages/adapters/akamai/README.md#what-isnt-confirmed): never on a live Akamai property. |
| **Azure Functions and Front Door** | **4. Simulated** | `npm run conformance:azure`: the bundle behind `conformance/src/azure-emulator.ts`, a stand-in for Front Door and the Functions host. Unit tests use `@azure/functions`' own `HttpRequest`. Static: `az bicep build` on the templates. | The list in [Testing without an Azure account](../packages/adapters/azure-functions/README.md#testing-without-an-azure-account): the templates on Azure, the real host's cookie serialization, Front Door's real headers. |
| **Google Cloud Run functions and Load Balancing** | **4. Simulated** | `npm run conformance:gcp`: the bundle served by the real Functions Framework, behind `conformance/src/gcp-emulator.ts`, a stand-in for the load balancer. Static: `terraform validate`. | The list in [Testing without a Google Cloud account](../packages/adapters/gcp-functions/README.md#testing-without-a-google-cloud-account): the Terraform on Google Cloud, the real `X-Forwarded-For` shape. |
| **Vercel** | **4. Simulated** | `npm run conformance:vercel`: the bundle behind `conformance/src/vercel-emulator.ts`, a stand-in for Vercel's proxy; the bundle step checks it has no Node.js built-ins. The [example](../packages/adapters/vercel/example/README.md) under `next start` passes the default-configuration cases when run by hand (not in CI, no recorded date). | The list in [Testing without a Vercel account](../packages/adapters/vercel/README.md#testing-without-a-vercel-account): Vercel's real headers, Routing Middleware, Vercel's CDN not caching. |
| **Node.js server**, behind the site's own proxy or load balancer | **4. Simulated** | The server itself is the conformance suite's reference target (`npm run conformance`, in the `checks` job): the real server in Node.js, every case. The proxy in front of it is simulated: `packages/adapters/node/test/proxy.test.ts` stands in for a CDN that overwrites the client IP and location headers. | The [per-CDN settings](../packages/adapters/node/README.md#per-cdn) against the CDNs themselves; TLS termination; IP sharing. |

### Upstream-operator endpoints

One endpoint in trusted-upstream mode, behind each publisher's CDN ([model B](upstream-operators.md#model-b-the-publishers-cdn-forwards-to-your-endpoint)). The mode itself is covered by `conformance/cases/trusted-upstream.json` (a missing, wrong, repeated or rotated secret, a forged country, GDPR from the forwarded country, forwarded IPv4 and IPv6, per-publisher settings by forwarded host, an unlisted or missing host, a host list), on every target below.

| Endpoint | Level | Evidence | Not proven |
| --- | --- | --- | --- |
| **Cloudflare Worker**, on a custom domain | **1. Live, automated** | [`e2e-upstream.yml`](../.github/workflows/e2e-upstream.yml), the [upstream-operator live tests](#live-tests-upstream-operator), on `sid.saleshouse.dev` behind the Cloudflare publisher recipe: [`check-live-site`](#check-live-site) with the endpoint (called directly, with no headers or with a forged secret, forwarded host, client IP and country, `/_sid/v1` and `/_sid/sync` answer `403` with no cookie; the visitor's real address and country arrive through the publisher), and the publisher's `verify-deployment`, conformance and browser tests (below). First green run on 17 November 2026 ([run](https://github.com/patmmccann/sharedid-edge/actions/runs/44018521159)). Set up and run by hand on 16 November 2026 ([#149](https://github.com/patmmccann/sharedid-edge/pull/149), [#136](https://github.com/patmmccann/sharedid-edge/issues/136)), which also checked per-publisher settings by forwarded host, a forwarded `DE` deciding GDPR, and forwarded IPv4 and IPv6 reaching `ip`. Emulated: `trusted-upstream.json` in workerd. | GDPR from a real EU visitor. Behind the CloudFront publisher, only by hand so far (16 November 2026; the recipe's row below). |
| **Fastly Compute** | **3. Emulated** | `trusted-upstream.json` in Viceroy. | Never live, with a real VCL service in front ([#150](https://github.com/patmmccann/sharedid-edge/issues/150)). |
| **Node.js server** | **4. Simulated** | `trusted-upstream.json` against the server (`npm run conformance`); the load balancer in front isn't part of it. | Never live. |
| **AWS Lambda**, behind the upstream operator's own CloudFront distribution | **4. Simulated** | `trusted-upstream.json` behind the Lambda stand-in. On AWS Emulator, its per-publisher cases are a listed limitation (the emulator's function URL doesn't pass `X-Forwarded-Host` through). | Never live, behind a real distribution ([#150](https://github.com/patmmccann/sharedid-edge/issues/150); the adapter's [Behind a publisher's CDN](../packages/adapters/aws-lambda/README.md#behind-a-publishers-cdn-trusted-upstream)). |
| Cloudflare Snippet, Vercel, Azure, Google Cloud, Akamai | Not supported | They refuse trusted-upstream settings. The Vercel, Azure, Google Cloud and Akamai targets list `trusted-upstream.json` as a known limitation, and the runner fails if any of its cases passes, so the refusal is checked. | |

### Publisher CDN recipes

The publisher-side configuration that forwards `/_sid/*` to an upstream-operator endpoint ([Publisher CDN recipes](upstream-operators.md#publisher-cdn-recipes)).

| Recipe | Level | Evidence | Not proven |
| --- | --- | --- | --- |
| **[Cloudflare](upstream-operators.md#cloudflare-the-publishers-zone-your-endpoint-elsewhere)**, the forwarding Worker | **1. Live, automated** | [`live/forward.js`](../packages/adapters/cloudflare/live/forward.js), the recipe as written, on `saleshouse-pub.sharedid.dev` in front of the Cloudflare Worker endpoint, redeployed and checked by the [upstream-operator live tests](#live-tests-upstream-operator): `check-live-site` 10 of 10 (the visitor's real address and region reach the endpoint; forged `X-SID-*`, `X-Forwarded-*`, `X-SID-Upstream-Auth` and `X-Real-IP` change nothing; the endpoint called directly answers `403`), `verify-deployment` 11 of 11, conformance 26 of 26 (on `saleshouse-conformance.sharedid.dev`, default settings), and the browser tests 14 of 14 in each of Chromium, Firefox and WebKit. First green run on 17 November 2026 ([run](https://github.com/patmmccann/sharedid-edge/actions/runs/44018521159)); before it, by hand on 16 November 2026 ([#149](https://github.com/patmmccann/sharedid-edge/pull/149)). | A real EU visitor; other endpoints behind it. |
| Cloudflare, without a Worker (Transform Rules, Origin Rule, Cache Rule) | **5. Documented only** | The recipe's last paragraph. | All of it. |
| **[Amazon CloudFront](upstream-operators.md#amazon-cloudfront)** | **2. Live, manual** (16 November 2026) | [`live/publisher-cloudfront.yaml`](../packages/adapters/cloudflare/live/publisher-cloudfront.yaml), the recipe's function, origin header, `CachingDisabled` and `AllViewerExceptHostHeader`, on `pub.hotba.be` (its own domain, DNS on Route 53) in front of the Cloudflare Worker endpoint ([#151](https://github.com/patmmccann/sharedid-edge/pull/151)): the visitor's real address and region from CloudFront's viewer headers, forged headers change nothing, `verify-deployment` passes (the endpoint on the site's own CloudFront addresses, `Domain=hotba.be`, not served from CloudFront's cache), the browser tests 42 of 42. Static: `cfn-lint` on the template in CI. The [upstream-operator live tests](#live-tests-upstream-operator) have its checks but skip them until their CloudFront part is set up: the second policy, [`live/iam-policy.json`](../packages/adapters/cloudflare/live/iam-policy.json), attached to the AWS role, and the `PUBLISHER_ROUTE53_ZONE_ID` repository variable ([setting it up](../packages/adapters/cloudflare/README.md#the-upstream-operator-and-saas-workflow)). The row moves to level 1 once that part has run green. | The conformance suite through it (it ran through the Cloudflare publisher); a real EU visitor. |
| [Fastly (VCL)](upstream-operators.md#fastly-vcl) | **5. Documented only** | Fastly's documentation. | All of it ([#150](https://github.com/patmmccann/sharedid-edge/issues/150)). |
| [Akamai](upstream-operators.md#akamai) | **5. Documented only** | Akamai's documentation. | All of it. |
| [nginx](upstream-operators.md#nginx) | **5. Documented only** | nginx's documentation. | All of it. |
| [HAProxy](upstream-operators.md#haproxy) | **5. Documented only** | HAProxy's documentation. | All of it. |
| [Azure Front Door](upstream-operators.md#azure-front-door) | **5. Documented only** | Front Door's documentation. | All of it. |

### Hosting-company models

One deployment for many sites ([Choosing a deployment](hosting-companies.md#choosing-a-deployment)). `SID_HOSTS` itself is covered by `conformance/cases/hosts.json` and `hosts-unlisted.json` on every target.

| Model | Level | Evidence | Not proven |
| --- | --- | --- | --- |
| **Cloudflare for SaaS**, one Worker on `*/_sid/*` with `SID_HOSTS` | **1. Live, automated** | [`live/saas.sh`](../packages/adapters/cloudflare/live/saas.sh)'s Workers, redeployed and checked by the [upstream-operator live tests](#live-tests-upstream-operator) on the custom hostname `saas.hotba.be` (DNS on Route 53) of a Free-plan SaaS zone: `check-live-site` 8 of 8 (`request.cf` is the visitor's; forged headers change nothing; `SID_HOSTS` picks its settings, `Domain=hotba.be`; the unlisted custom hostname `saas2.hotba.be` gets a `404` with no cookie on both paths), `verify-deployment` 11 of 11 (`*/_sid/*` answers from the site's Cloudflare addresses), and the browser tests 14 of 14 in each of three browsers. First green run on 17 November 2026 ([run](https://github.com/patmmccann/sharedid-edge/actions/runs/44018521159)); set up and run by hand on 16 November 2026 ([#149](https://github.com/patmmccann/sharedid-edge/pull/149)). | `request.cf.isEUCountry` for a real EU visitor ([#150](https://github.com/patmmccann/sharedid-edge/issues/150)). |
| Cloudflare for SaaS, with [custom hostname metadata](hosting-companies.md#cloudflare-for-saas-custom-hostname-metadata) | **4. Simulated** | The Worker's unit tests (`packages/adapters/cloudflare/test/worker.test.ts`, run in workerd) pass `request.cf.hostMetadata` in the request. | Metadata reaching the Worker from Cloudflare (it needs Cloudflare's account team to enable it; [#150](https://github.com/patmmccann/sharedid-edge/issues/150)). |
| Cloudflare for SaaS with Workers for Platforms | **5. Documented only** | The Cloudflare adapter's [Hosting companies](../packages/adapters/cloudflare/README.md#hosting-companies). The Worker each publisher gets is the live-tested Worker. | The dispatch Worker and the trusted namespace's `request.cf` ([#150](https://github.com/patmmccann/sharedid-edge/issues/150)). |
| Publishers on their own Cloudflare zones, a Worker in each account | **1. Live, automated** | This is the Worker's own deployment (above). | As for the Worker. |
| A Cloudflare Snippet on a SaaS zone | **5. Documented only** | The guide advises against it. | Whether snippet rules run for custom hostnames at all ([#105](https://github.com/patmmccann/sharedid-edge/issues/105)). |
| [Orange-to-orange](hosting-companies.md#orange-to-orange-with-a-worker-on-one-side-and-a-snippet-on-the-other) (the publisher's zone on Cloudflare, proxying to yours) | **5. Documented only** | The guide advises against it. | Which zone's route answers, and whose location `request.cf` has ([#150](https://github.com/patmmccann/sharedid-edge/issues/150), deprioritized). |
| [Amazon CloudFront](hosting-companies.md#amazon-cloudfront-and-lambda), one distribution with many alternate domain names | **5. Documented only** | The Lambda handler with `SID_HOSTS` is simulated (`hosts.json` behind the Lambda stand-in). The CloudFront Function that copies `Host` into `X-Forwarded-Host` is written from CloudFront's documentation; the upstream-operator CloudFront recipe, which makes the same copy, ran live, but in front of a Worker, not this function behind origin access control. | The function in front of the Lambda function. |
| Fastly, one service with many domains (Request Routing) | **5. Documented only** | The Compute service with `SID_HOSTS` is emulated in Viceroy. | Request Routing passing each site's `Host` ([Fastly: Routing](../packages/adapters/fastly/README.md#routing)). |
| Akamai, one property with many hostnames | **4. Simulated** | `hosts.json` behind the Akamai stand-in, with `PMUSER_SID_HOSTS`. | As for the Akamai adapter. |
| Vercel, a multi-tenant project | **4. Simulated** | `hosts.json` behind the Vercel stand-in. | As for the Vercel adapter. |
| Google Cloud, an external Application Load Balancer | **4. Simulated** | `hosts.json` behind the load balancer stand-in. | The `Host` the real load balancer passes. |
| Azure Front Door, one function app per site | **4. Simulated** | As for the Azure adapter. | As for the Azure adapter. |
| Your own nginx, HAProxy or ingress, in front of the Node.js server | **4. Simulated** | `hosts.json` against the Node.js server; the proxy stand-in in `packages/adapters/node/test/proxy.test.ts`. | Your proxy's configuration. |

### Opt-in and vendor modules

Modules don't have deployments of their own: these rows say where each has run. Every module's conformance cases run on every target, so a module is emulated on the Worker and on Fastly, and simulated elsewhere, unless the row says more.

| Module | Level | Evidence | Not proven |
| --- | --- | --- | --- |
| `reflect`, `clickid` | **1. Live, automated** on the Cloudflare Worker and on AWS | The live `e2e` environment runs them (`packages/adapters/cloudflare/wrangler.jsonc`), as does the AWS live tests' `sharedid-e2e` function, and four browser tests check `reflect`'s `uid1` and `_ga` and one `clickid`'s `gclid`. | |
| `ip`, `geo` | **1. Live, automated** on AWS and Cloudflare | Through CloudFront, `check-cloudfront` on every AWS live run; on Cloudflare, `check-live-site` on every upstream-operator live run, through the Cloudflare publisher (trusted upstream) and on the SaaS hostname (`request.cf`): the visitor's real address and location. | An EU location; the live conformance runs use only the default configuration, which has no modules. |
| `ua`, `bot` | **1. Live, automated** on AWS | `check-cloudfront` on every AWS live run: Chrome's Client Hints become `device.sua`, and `Accept-Language` arrives, so `bot` doesn't flag a likely bot. | Not live on Cloudflare; Bot Management's data (an Enterprise add-on). |
| `ua` with Bowser (an opt-in build) | **3. Emulated** | `module-ua-bowser.json` in workerd and Viceroy, simulated on the other targets; CI builds the Worker with Bowser and checks the size budget. | Never deployed live. |
| `ec` (a vendor module, an IP-derived ID) | **3. Emulated** | The `module-ec*.json` case files (minting from IPv4 and IPv6, the EID, GDPR by location, consent deleting `ts-ec`, an invalid passphrase) in workerd and Viceroy, simulated on the other targets; its own tests in the `vendor-modules` job. | Never deployed live; GDPR for a real EU visitor. |
| `dbip`, `maxmind` (vendor modules) | **3. Emulated** | Their case files, with fixture databases, as for `ec`. | Never deployed live. |

### Counts

Counting each row of the first four tables once (not the unsupported endpoints, nor the modules):

| Level | Deployments |
| --- | --- |
| 1. Live, automated | 6: the Cloudflare Worker, the same Worker in each publisher's own Cloudflare account, AWS Lambda and CloudFront, the Cloudflare Worker as an upstream-operator endpoint, the Cloudflare publisher recipe, and Cloudflare for SaaS with `SID_HOSTS` |
| 2. Live, manual | 1: the CloudFront publisher recipe |
| 3. Emulated | 2: Fastly Compute, and Fastly Compute as an upstream-operator endpoint |
| 4. Simulated | 14: the Snippet; Akamai, Azure, Google Cloud, Vercel and Node.js; Node.js and Lambda as upstream-operator endpoints; custom hostname metadata; Akamai, Vercel, Google Cloud, Azure and Node.js for many sites |
| 5. Documented only | 11: six publisher CDN recipes; Workers for Platforms, Snippets on SaaS zones, orange-to-orange, CloudFront with many domains, and Fastly Request Routing. No platform adapter is documented only |

That's 34 rows. The 11 documented-only rows are the first place to look when a deployment behaves unexpectedly.

## The behaviour that must not regress

The project's rules ([AGENTS.md](../AGENTS.md#changing-behaviour)) and Safari's same-IP rule, and which checks hold them at each level:

| Rule | Live, automated (Cloudflare) | Other live runs | Emulated and simulated |
| --- | --- | --- | --- |
| **An existing valid ID is never replaced;** the `HttpOnly` recovery copy restores a re-minted one | `sync.json` (never replaces an existing cookie, restores from the recovery copy, restores the original after a re-mint); browser tests: a second visit keeps the first visit's ID, and a cleared script cookie is restored | The same, on AWS, the upstream-operator publishers and the SaaS hostname | `sync.json` on every target; real Safari (local server) |
| **The worker answers only its own routes** and never forwards to the origin | Indirectly: the test page on `e2e.sharedid.dev/*` comes from another Worker while `/_sid/*` goes to SharedID Edge. `routes.json` isn't run live, since it needs an allowed origin | The SaaS run: a `/_sid/*` route answers only for listed custom hostnames | `routes.json` on every target (nothing outside the base path, a 404 for unknown routes, other methods refused) |
| **Opt-out, GPC, COPPA and denied consent** delete existing ID cookies and set none | `consent.json` (withdrawn consent, GPC and COPPA each delete existing cookies; no TC string where GDPR applies sets nothing), `sync.json`'s opt-out case; browser tests: the `denied` TC string deletes what an earlier visit left, and an opted-out visitor gets no ID | `Sec-GPC` through CloudFront (`check-cloudfront`); a forwarded `DE` without a TC string (upstream operator) | All of these, plus GDPR by the visitor's location (`consent-eu-location.json`), on every target |
| **No IP-derived IDs in core** or the project's modules | Minted IDs are checked to be UUIDs (the browser tests, `sync.json`'s pattern for a version 4 UUID) | `check-cloudfront`: two requests from the same address get two different IDs | `npm run check:docs` refuses a project module that declares `ipDerived`. No test can prove an ID isn't derived from anything: the rule is held by review and [the vendor rules](../packages/vendor-modules/AGENTS.md#ip-derived-ids) |
| **`Access-Control-Allow-Origin` is never `*`** | Not checked live (the default configuration allows no origin) | `check-cloudfront`: the allowed origin gets itself back, another gets no CORS headers | `routes.json`'s CORS cases on every target except AWS Emulator, which refuses requests with an `Origin` header |
| **Safari's same-IP rule:** the endpoint answers from the site's own IP addresses | `verify-deployment`'s DNS check | `verify-deployment` on AWS, both upstream-operator publishers and the SaaS hostname | Can't be emulated. Real Safari runs in CI against a local server, so it checks Safari's cookie handling, not the IP rule |

## The verification workflows

### CI, on every pull request

[`ci.yml`](../.github/workflows/ci.yml) runs on every pull request and every push to `main`, with no secrets and no platform account, so pull requests from forks get every check. Inspect it at [Actions → CI](https://github.com/patmmccann/sharedid-edge/actions/workflows/ci.yml), or on the pull request's checks. Run it locally with `npm run check`, plus the commands below. A failing job uploads what it can: the Playwright report (`playwright-report-<browser>`) or the duplication report, kept for 7 days.

| Job | What it runs | Level it gives |
| --- | --- | --- |
| `checks` | Types (TypeScript 6 and 7, the Workers runtime types), lint, unit tests (the Worker's inside workerd), the conformance suite against the Node.js server, the Snippet build and `test:snippet`, the size budgets, and the conformance suite behind the Lambda, Vercel, Azure, Google Cloud and Akamai stand-ins | Simulated (and emulated, for the Worker's unit tests) |
| `conformance-workerd` | The full suite against the Worker in `wrangler dev` | Emulated |
| `conformance-fastly` | The full suite and `fastly-checks.ts` against the compiled package in Viceroy, default and reusable sandboxes | Emulated |
| `lambda-aws-emulator` | The full suite through a Lambda function URL on AWS Emulator, a pinned version. Not required yet (`continue-on-error`) | Emulated |
| `vendor-modules` | Each vendor module's own tests | Unit tests |
| `e2e-chromium`, `e2e` (Firefox, WebKit) | The [browser tests](#the-browser-tests) against `e2e/server.ts`: the core handler and the `reflect` and `clickid` modules, not an adapter, serving the page and `/_sid/*` from one origin | Simulated: they prove the Prebid.js contract, not a platform |
| `e2e-safari` | The four core browser tests in real Safari on a macOS runner, through `safaridriver`, against the same local server | Simulated, in the real browser |
| `aws-template`, `azure-template`, `gcp-terraform` | `cfn-lint`, `az bicep build`, `terraform validate` | Static checks |
| `website` | Builds sharedid.dev; dead links and anchors fail | Docs only |

### Live tests (Cloudflare)

[`e2e-cloudflare.yml`](../.github/workflows/e2e-cloudflare.yml). Details in the Cloudflare adapter's [Live tests](../packages/adapters/cloudflare/README.md#live-tests).

- **Trigger:** every push to `main` (a merged pull request), nightly at 04:17 UTC, and on demand (*Run workflow* on the Actions tab). Never on pull requests. Runs don't overlap; of several waiting, only the newest runs.
- **Infrastructure:** the test zone `sharedid.dev`, on Cloudflare's Free plan. Three Workers: `sharedid-edge-e2e` on `e2e.sharedid.dev/_sid/*` (the `e2e` environment in `wrangler.jsonc`: no pixel caching, `reflect` with `uid1` and `_ga`, and `clickid`); `sharedid-edge-e2e-site` on `e2e.sharedid.dev/*` (the test page and a Prebid.js bundle of a typical publisher setup, from `e2e/site/`); and `sharedid-edge-conformance` on `conformance.sharedid.dev/_sid/*` (the default configuration).
- **Steps:** deploy the three Workers; wait until both hostnames answer; [`verify-deployment`](#verify-deployment) against `https://e2e.sharedid.dev`; the [conformance suite](#the-conformance-suite)'s default-configuration cases (26) against `https://conformance.sharedid.dev/_sid`; then the 14 [browser tests](#the-browser-tests) against `https://e2e.sharedid.dev`, with cookie domain `sharedid.dev`, in Chromium, Firefox and WebKit, each its own job.
- **What a pass proves:** on Cloudflare's real edge, as of that run, the route on the site's own hostname answers from the site's IP addresses (Safari's rule); the cookies are `Secure`, long-lived and set by the server, on the right domain; an existing ID is kept and restored; denied consent, GPC, COPPA and opt-out set nothing and delete what's there; and unmodified Prebid.js gets and keeps a server-set SharedID in three browser engines.
- **What it doesn't:** see level 1 above: one vantage point in the US, the default and browser-test configurations only, no CORS or forged-header checks, no real Safari.
- **A failure** after a merge or overnight opens an issue titled "Live Cloudflare tests are failing", or comments on the open one; a later green run on `main`, including a re-run of the failed jobs, closes it as completed ([`.github/actions/live-issue`](../.github/actions/live-issue/action.yml)). The browser jobs upload `playwright-report-live-<browser>` on failure, kept for 7 days.
- **Inspect it:** [Actions → Live tests (Cloudflare)](https://github.com/patmmccann/sharedid-edge/actions/workflows/e2e-cloudflare.yml). Each run's log shows `verify-deployment`'s checks and the suite's TAP output case by case.

### Live tests (AWS)

[`e2e-aws.yml`](../.github/workflows/e2e-aws.yml). Details in the Lambda adapter's [Live tests](../packages/adapters/aws-lambda/README.md#live-tests).

- **Trigger:** as for Cloudflare: every push to `main` (a merged pull request), nightly at 04:47 UTC, and on demand. Never on pull requests. It assumes an IAM role through GitHub's OIDC, with no stored keys; without the `AWS_E2E_ROLE_ARN` repository variable (in a fork, say), its only job prints a notice ("AWS live tests aren't set up") and the run succeeds, so a green run is a live test only if the "Deploy to CloudFront, verify, conformance" job ran.
- **Infrastructure:** four CloudFormation stacks in the AWS test account (us-east-1), deployed by [`live/deploy.sh`](../packages/adapters/aws-lambda/live/deploy.sh): `sharedid-e2e` (the function with the browser tests' settings, on `/_sid`), `sharedid-e2e-platform` (`ip,geo,ua,bot` and an allowed origin, on `/_sid-platform`), `sharedid-e2e-site` (the test page in a private S3 bucket behind a distribution with both behaviours) and `sharedid-e2e-conformance` (the default settings on a distribution of its own). The site is on the distribution's `*.cloudfront.net` hostname.
- **Steps:** `verify-deployment` against the site; [`check-cloudfront`](#check-cloudfront) against `/_sid-platform`; the 26 default-configuration conformance cases against the conformance distribution; the 14 browser tests in three browsers.
- **What a pass proves:** the template deploys; origin access control and the function URL's resource policy work (the function URL refuses direct requests); CloudFront passes the viewer address and location, the User-Agent and Client Hints, `Origin` and `Sec-GPC`, and replaces forged copies; and the rest as for Cloudflare.
- **Recorded result:** the first green run, on 17 November 2026 ([run](https://github.com/patmmccann/sharedid-edge/actions/runs/44015773690)), passed `verify-deployment`, `check-cloudfront` 11 of 11, conformance 26 of 26 and the browser tests 14 of 14 in each browser; the run history has every run since. Before it, the same steps run by hand on 12 November 2026 ([#141](https://github.com/patmmccann/sharedid-edge/pull/141)). To run them by hand, see [Live tests](../packages/adapters/aws-lambda/README.md#live-tests).
- **Inspect it:** [Actions → Live tests (AWS)](https://github.com/patmmccann/sharedid-edge/actions/workflows/e2e-aws.yml). A failure opens "Live AWS tests are failing" and uploads `playwright-report-aws-<browser>`; a later green run that deployed closes the issue.

### Live tests (upstream operator)

[`e2e-upstream.yml`](../.github/workflows/e2e-upstream.yml). Details, and the setup checklist, in the Cloudflare adapter's [upstream operator and SaaS workflow](../packages/adapters/cloudflare/README.md#the-upstream-operator-and-saas-workflow).

- **Trigger:** as for Cloudflare: every push to `main` (a merged pull request), nightly at 05:17 UTC, and on demand. Not on pull requests, by design ([#154](https://github.com/patmmccann/sharedid-edge/issues/154)): a pull request's code would run with the deploy credentials, pull requests from forks get no secrets, and the runs share one set of hostnames, so the live tests stay on `main`, where a failure after a merge opens an issue.
- **Secrets and variables:** the secrets `CLOUDFLARE_API_TOKEN` (with access to `saleshouse.dev`), `CLOUDFLARE_ACCOUNT_ID`, `UPSTREAM_SECRET_CLOUDFLARE` and `UPSTREAM_SECRET_CLOUDFRONT`, which this repository has. Without them (in a fork, say), its only job prints a notice naming the missing ones and the run succeeds, so a green run is a live test only if the deploy job ran. The CloudFront publisher also needs the `AWS_E2E_ROLE_ARN` and `PUBLISHER_ROUTE53_ZONE_ID` variables and the second AWS policy, and is skipped on its own without them. Here `PUBLISHER_ROUTE53_ZONE_ID` and the second policy aren't set yet, so it's skipped, with a notice.
- **Infrastructure:** the [live setups below](#the-upstream-operator-and-cloudflare-for-saas-live-setups). Each run deploys the four Workers (`upstream.sh workers`, `saas.sh workers`) and, with AWS, updates the `sharedid-saleshouse-pub` stack and its test page (`upstream.sh cloudfront`). The DNS records, custom hostnames, the SaaS fallback origin and the publisher's certificate are one-time setup the workflow doesn't touch.
- **Steps:** for `saleshouse-pub.sharedid.dev` and `pub.hotba.be`, [`check-live-site`](#check-live-site) with the endpoint (direct calls to `sid.saleshouse.dev` get `403`, with or without forged headers; the real address and country arrive; forged headers change nothing) and `verify-deployment`; for `saas.hotba.be`, `check-live-site` (`Domain=hotba.be`, and `saas2.hotba.be` gets a `404` with no cookie) and `verify-deployment`; the 26 default-configuration conformance cases against `https://saleshouse-conformance.sharedid.dev/_sid`; the 14 browser tests against each of the three sites in Chromium, Firefox and WebKit.
- **What a pass proves:** what the manual runs below proved, as of that run, for the commit on `main`.
- **Recorded result:** the first green run, on 17 November 2026 ([run](https://github.com/patmmccann/sharedid-edge/actions/runs/44018521159)), passed, for `saleshouse-pub.sharedid.dev` behind `sid.saleshouse.dev`, `check-live-site` 10 of 10 and `verify-deployment` 11 of 11; for `saas.hotba.be`, `check-live-site` 8 of 8 (with `saas2.hotba.be` unlisted) and `verify-deployment` 11 of 11; conformance 26 of 26 on `saleshouse-conformance.sharedid.dev`; and the browser tests 14 of 14 in Chromium, Firefox and WebKit on both sites. The CloudFront publisher was skipped. That run moved the upstream-operator endpoint, the Cloudflare recipe and Cloudflare for SaaS to level 1; the CloudFront recipe moves once its part has run green.
- **Inspect it:** [Actions → Live tests (upstream operator)](https://github.com/patmmccann/sharedid-edge/actions/workflows/e2e-upstream.yml). A failure opens "Live upstream-operator tests are failing" and uploads `playwright-report-upstream-<site>-<browser>`; a later green run that deployed the Workers closes the issue (a skipped CloudFront publisher doesn't stop it).

### The upstream-operator and Cloudflare for SaaS live setups

Set up once by hand, since they need domains, DNS records and custom hostnames; [the workflow above](#live-tests-upstream-operator) then redeploys their Workers and stack. The Cloudflare adapter's [upstream-operator and SaaS setups](../packages/adapters/cloudflare/README.md#the-upstream-operator-and-cloudflare-for-saas-setups) has every variable, command and the teardown.

- **Scripts:** [`live/upstream.sh`](../packages/adapters/cloudflare/live/upstream.sh) (`workers`, `cloudfront`, or both) and [`live/saas.sh`](../packages/adapters/cloudflare/live/saas.sh) (`setup`, `workers`, or both). They deploy; [`check-live-site`](#check-live-site) and the commands in the README check.
- **Infrastructure:** `saleshouse.dev` (Cloudflare) for the upstream operator, `sid.saleshouse.dev`, the Worker in trusted-upstream mode; `sharedid.dev` for the publishers on Cloudflare (`saleshouse-pub.sharedid.dev` with the browser tests' settings, `saleshouse-conformance.sharedid.dev` with the defaults) and as the SaaS zone; and `hotba.be` (Route 53) for the publisher on CloudFront (`pub.hotba.be`, the `sharedid-saleshouse-pub` stack) and the SaaS custom hostnames (`saas.hotba.be`, and `saas2.hotba.be`, unlisted).
- **Checks, per publisher hostname:** `verify-deployment`; with `check-live-site`, or by hand: `/_sid/v1` shows your own address and location; the same with forged `X-SID-Client-IP`, `X-SID-Country`, `X-Forwarded-Host`, `X-SID-Upstream-Auth` (and `X-Forwarded-For`) shows the same; the endpoint called directly answers `403`; the default-configuration conformance cases against the conformance publisher; the browser tests with `E2E_BASE_URL` and `E2E_COOKIE_DOMAIN` set to the publisher's.
- **Recorded results:** 16 November 2026, in [#149](https://github.com/patmmccann/sharedid-edge/pull/149) and [#136](https://github.com/patmmccann/sharedid-edge/issues/136) (the Cloudflare recipe, the endpoint and Cloudflare for SaaS) and [#151](https://github.com/patmmccann/sharedid-edge/pull/151) (the CloudFront recipe); summarized in the guides' What's been verified live ([upstream operators](upstream-operators.md#whats-been-verified-live), [hosting companies](hosting-companies.md#whats-been-verified-live)).

### The website workflow

[`website.yml`](../.github/workflows/website.yml) builds and deploys sharedid.dev on every merge to `main` and weekly, and checks the site answers. It verifies the documentation site, not SharedID Edge.

## What the checks assert

### verify-deployment

[`scripts/verify-deployment.ts`](../scripts/verify-deployment.ts), `npm run verify-deployment -- --site https://www.example.com [--endpoint …]`. It checks a deployment from outside, as a browser sees it:

1. **DNS:** the endpoint is on the site's own hostname, or its host shares at least one IP address with the site's (Safari caps cookies from a server whose address doesn't match the site's). Not `https` fails.
2. **`/_sid/sync`, as Prebid.js calls it on a first visit,** with a fresh ID: `200 image/gif`; sets `_pubcid` with that ID (adopted, not replaced), a `Max-Age` of at least 300 days, `Secure`, `SameSite=Lax`, not `HttpOnly`, and a `Domain` that covers the site; sets the `_pubcid_sv` recovery copy `HttpOnly` (a warning if it's off); not served from a shared cache (`cf-cache-status`, `x-cache` or `age`).
3. **`/_sid/v1`** returns payload version 1.

### check-cloudfront

[`scripts/check-cloudfront.ts`](../scripts/check-cloudfront.ts), for the AWS live tests only, against a function with `SID_MODULES=ip,geo,ua,bot` and an allowed origin: `/v1` answers through CloudFront (`x-amz-cf-pop`); caching is off (two requests, two new IDs, no cache hit); the client IP is the address `checkip.amazonaws.com` sees; there's a `device.geo` country; Chrome's Client Hints become `device.sua`; `Accept-Language` arrives (no likely bot); forged `CloudFront-Viewer-*` and `X-Forwarded-For` are replaced; the allowed origin gets CORS and another doesn't; `Sec-GPC: 1` gets `denied: gpc` and no ID; and, with `--function-url`, the function URL refuses direct requests.

### check-live-site

[`scripts/check-live-site.ts`](../scripts/check-live-site.ts), for the upstream-operator and SaaS live tests: `npx tsx scripts/check-live-site.ts --site https://<site> --cookie-domain <domain> [--endpoint https://<upstream endpoint>] [--unlisted https://<unlisted hostname>]`, against a site whose SharedID Edge runs `ip` and `geo`. `/_sid/v1` has the address two echo services see, and a country; forged `X-SID-Client-IP`, `X-SID-Country`, `X-SID-Region`, `X-SID-Upstream-Auth`, `X-Forwarded-Host`, `X-Forwarded-For` and `X-Real-IP` change nothing in `/_sid/v1` or `/_sid/sync` (the same address and location, the cookie on the same domain, GDPR not decided by a forged `DE`); `/_sid/sync` sets `_pubcid` with `Domain=<domain>`. With `--endpoint`, `/_sid/v1` and `/_sid/sync` on the endpoint itself answer `403` with no cookie, with no headers and with a forged secret, forwarded host, client IP and country. With `--unlisted`, both answer `404` with no cookie on a hostname that isn't in `SID_HOSTS`.

### The conformance suite

The contract every implementation passes ([`conformance/`](../conformance/AGENTS.md)): JSON case files in `conformance/cases/`, each with the settings its target runs with.

- **Against a local target** (`--target node|wrangler|lambda|lambda-aws-emulator|vercel|azure|gcp|akamai|fastly`), every case file runs, each with its own settings: consent, GDPR by location, routes and CORS, cookie options, `SID_HOSTS`, trusted-upstream mode, forged headers without it, and every module. A case a platform can't pass is listed with its reason in `conformance/src/targets.ts` and reported as `# TODO`; the run fails if a listed case starts passing.
- **Against a deployment** (`--base-url https://…/_sid`), only the files with the default configuration run, since a deployment has one: `consent.json` (15 cases) and `sync.json` (11), 26 in all. They need no client IP or location of their own, which a live run can't choose.

### The browser tests

[`e2e/tests/prebid-sharedid.spec.ts`](../e2e/tests/prebid-sharedid.spec.ts): 14 Playwright tests, each run in Chromium, Firefox and WebKit (so "42 of 42" is all of them in all three), with unmodified Prebid.js (a bundle of a typical publisher setup at the version `e2e/package.json` pins) and a static TCF consent string. They read requests and cookies from the browser's side, so the same tests run locally and against a live site (`E2E_BASE_URL`, `E2E_COOKIE_DOMAIN`). They check:

- a first visit's ID, minted by Prebid.js and sent to `pixelUrl`, comes back as a server-set `_pubcid` lasting more than 360 days, with an `HttpOnly` `_pubcid_sv`, and Prebid.js reads it; a second visit keeps it;
- there's one `_pubcid`, on the expected domain;
- with consent, GDPR applies and both cookies are set; without purpose 1 consent, neither Prebid.js nor the endpoint stores an ID, and the endpoint deletes what an earlier visit left (`denied: tcf: no publisher consent for purpose 1`); where GDPR doesn't apply, everything works;
- a cleared script cookie is restored from the recovery copy;
- `pbjs.getUserIdsAsync()` resolves on a later visit;
- the `reflect` module refreshes and restores a vendor's `uid1` and `_ga` (four tests), and `clickid` keeps a landing page's `gclid` for 90 days;
- after an opt-out, the endpoint sets no ID cookies.

WebKit isn't Safari: it doesn't apply Safari's 7-day cap on script-set cookies, so the tests clear the cookie to simulate one. [`e2e/safari/safari.test.ts`](../e2e/safari/safari.test.ts) runs four of the core tests in real Safari ([Real Safari](../e2e/AGENTS.md#real-safari)), in CI against the local server only.

## Not verified yet

What would raise a level, and where it's tracked:

- **A visitor in the EU** on any live run (`request.cf.isEUCountry`, a CDN's real country header deciding GDPR): every live run so far came from the US. [#150](https://github.com/patmmccann/sharedid-edge/issues/150).
- **The CloudFront publisher recipe in the upstream-operator live tests:** the workflow has its checks, but skips them until the second AWS policy is attached and `PUBLISHER_ROUTE53_ZONE_ID` is set ([setting it up](../packages/adapters/cloudflare/README.md#the-upstream-operator-and-saas-workflow)); then its row moves to level 1. The live tests don't run on pull requests, by design ([#154](https://github.com/patmmccann/sharedid-edge/issues/154)).
- **The Cloudflare Snippet live,** on a Pro zone. [#105](https://github.com/patmmccann/sharedid-edge/issues/105).
- **Lambda and Fastly as upstream-operator endpoints,** custom hostname metadata, Workers for Platforms and orange-to-orange. [#150](https://github.com/patmmccann/sharedid-edge/issues/150).
- **Fastly, Akamai, Azure, Google Cloud and Vercel** on live accounts, and the Fastly, Akamai, nginx, HAProxy and Azure Front Door publisher recipes. Each adapter's README lists what a first deployment should check.
- **Real Safari against a live deployment:** it can run against one by hand (`E2E_BASE_URL=… npm run test:safari` on a Mac), but no run is recorded.

If you run SharedID Edge on one of these, [an issue](https://github.com/patmmccann/sharedid-edge/issues) with what you checked and saw moves it up this page.

## Verifying your own deployment

Whatever its level here, check your own deployment before relying on it, with the same tools:

```sh
npm ci && npm run build
npm run verify-deployment -- --site https://www.example.com
node conformance/dist/run.js --base-url https://www.example.com/_sid      # on a deployment with the default settings
curl -s https://www.example.com/_sid/v1                                   # with ip and geo on: your own address and location
```

And with the browser tests (`npm ci --prefix e2e`, then in `e2e/`): `E2E_BASE_URL=https://www.example.com E2E_COOKIE_DOMAIN=example.com npx playwright test`, on a page that loads Prebid.js as the test site does. Each adapter's README has a Verify section with the platform's own checks.
