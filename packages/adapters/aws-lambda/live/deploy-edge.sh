#!/usr/bin/env bash
# Deploys this project's Lambda@Edge live tests (.github/workflows/e2e-aws.yml, the lambda-edge job; README.md,
# Lambda@Edge). Not for deployers.
#
#   npm run build                    # first: core, the modules and the adapter (bundle-edge.mjs validates with it)
#   npm ci --prefix e2e              # and e2e's dependencies, for the Prebid.js bundle
#   packages/adapters/aws-lambda/live/deploy-edge.sh
#
# Uses the AWS CLI's usual credentials (AWS_PROFILE, or the workflow's OIDC role), always in us-east-1, where
# Lambda@Edge functions must be. Every resource is named after SID_LIVE_PREFIX (default sharedid-e2e), so the live
# tests' policy (live/iam-policy.json) covers them. It creates or updates:
#
#   <prefix>-deploy-<account>    S3 bucket for the packaged code (shared with deploy.sh)
#   <prefix>-edge                edge-template.yaml, origin-request: the e2e settings, /_sid
#   <prefix>-edge-platform       edge-template.yaml, origin-request: ip, geo, ua and bot, /_sid-platform
#   <prefix>-edge-viewer         edge-template.yaml, viewer-request: ip, ua and bot, /_sid-viewer
#   <prefix>-edge-site           live/edge-site.yaml: the test site's bucket and distribution, with the three behaviours
#   <prefix>-edge-conformance    edge-template.yaml with CreateDistribution: the default configuration, its own distribution
#
# Each function's settings are baked into its bundle (npm run bundle:edge), so each is bundled, packaged and deployed in
# turn. A bundle that changed publishes a new function version and the site's behaviour moves to it; old versions are
# kept, since CloudFront deletes their replicas only hours after nothing uses them, and the stacks stay up between runs
# for the same reason. The e2e function's cookie domain is the site's hostname, which exists only once the site stack
# does, so a first deployment deploys the function stacks twice. It prints the hostnames as GitHub step outputs when
# GITHUB_OUTPUT is set.
set -euo pipefail

# Git Bash on Windows: don't turn arguments like /* or /_sid into Windows paths for aws.exe.
export MSYS_NO_PATHCONV=1
export AWS_REGION=us-east-1
export AWS_DEFAULT_REGION=us-east-1
aws="${AWS_CLI:-aws}"
prefix="${SID_LIVE_PREFIX:-sharedid-e2e}"

package_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_root="$(cd "$package_dir/../../.." && pwd)"
cd "$package_dir"
out=live/.out
mkdir -p "$out"

if [ ! -f dist/edge.js ]; then
  echo "dist/edge.js is missing: run npm run build first." >&2
  exit 1
fi

account="$("$aws" sts get-caller-identity --query Account --output text)"
deploy_bucket="$prefix-deploy-$account"

output() {
  "$aws" cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text 2>/dev/null | sed 's/^None$//' || true
}

deploy() {
  local stack="$1" template="$2"
  shift 2
  echo "Deploying $stack"
  "$aws" cloudformation deploy --stack-name "$stack" --template-file "$template" \
    --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND --no-fail-on-empty-changeset \
    --tags project=sharedid-edge purpose=live-tests \
    --parameter-overrides "$@"
}

if ! "$aws" s3api head-bucket --bucket "$deploy_bucket" >/dev/null 2>&1; then
  echo "Creating s3://$deploy_bucket"
  "$aws" s3api create-bucket --bucket "$deploy_bucket" >/dev/null
  "$aws" s3api put-public-access-block --bucket "$deploy_bucket" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
fi

# Bundles a function with the settings in $2 (JSON) for the event $3, packages edge-template.yaml with it, and deploys
# the stack $1 with any further parameters. The package's S3 key is the bundle's hash, so an unchanged bundle changes
# nothing and publishes no new version.
deploy_function() {
  local stack="$1" settings="$2" event="$3"
  shift 3
  printf '%s\n' "$settings" > "$out/$stack.json"
  node scripts/bundle-edge.mjs --config "$out/$stack.json" --event-type "$event"
  "$aws" cloudformation package --template-file edge-template.yaml --s3-bucket "$deploy_bucket" --s3-prefix lambda-edge \
    --output-template-file "$out/$stack.packaged.yaml" >/dev/null
  deploy "$stack" "$out/$stack.packaged.yaml" "EventType=$event" "$@"
}

# The three function stacks. $1: the site's domain, empty on a first deployment (host-only cookies until the second pass).
deploy_functions() {
  local domain="$1" cookie_domain uid1_domain=''
  cookie_domain="${domain:-host-only}"
  if [ -n "$domain" ]; then uid1_domain="\"domain\":\"$domain\","; fi
  # As the regional e2e function (deploy.sh) and the Cloudflare e2e environment: no pixel caching, reflect with uid1 and
  # _ga, and clickid; the cookie domain is the distribution's own (README.md, Live tests).
  deploy_function "$prefix-edge" "{\"SID_COOKIE_DOMAIN\":\"$cookie_domain\",\"SID_SYNC_CACHE_SECONDS\":\"0\",\"SID_MODULES\":\"reflect,clickid\",\"SID_MODULE_CONFIG\":{\"reflect\":{\"cookies\":[{\"name\":\"uid1\",\"maxAgeDays\":365,$uid1_domain\"httpOnly\":false,\"restore\":true},{\"name\":\"_ga\",\"maxAgeDays\":400,\"restore\":true}]}}}" origin-request
  # The modules that read what CloudFront adds (scripts/check-cloudfront.ts), with an allowed origin for CORS.
  deploy_function "$prefix-edge-platform" "{\"SID_COOKIE_DOMAIN\":\"$cookie_domain\",\"SID_BASE_PATH\":\"/_sid-platform\",\"SID_MODULES\":\"ip,geo,ua,bot\",\"SID_ALLOWED_ORIGINS\":\"https://allowed.example\"}" origin-request
  # Viewer-request: no location, so no geo, and GDPR applies to everyone without a TC string (the default).
  deploy_function "$prefix-edge-viewer" "{\"SID_COOKIE_DOMAIN\":\"$cookie_domain\",\"SID_BASE_PATH\":\"/_sid-viewer\",\"SID_MODULES\":\"ip,ua,bot\",\"SID_ALLOWED_ORIGINS\":\"https://allowed.example\"}" viewer-request
}

deploy_site() {
  deploy "$prefix-edge-site" live/edge-site.yaml \
    "SidFunctionVersionArn=$(output "$prefix-edge" FunctionVersionArn)" \
    "PlatformFunctionVersionArn=$(output "$prefix-edge-platform" FunctionVersionArn)" \
    "ViewerFunctionVersionArn=$(output "$prefix-edge-viewer" FunctionVersionArn)"
}

domain="$(output "$prefix-edge-site" DistributionDomainName)"
deploy_functions "$domain"
deploy_site
if [ -z "$domain" ]; then
  domain="$(output "$prefix-edge-site" DistributionDomainName)"
  deploy_functions "$domain"
  deploy_site
fi

# The conformance suite's default-configuration cases need /_sid with the defaults, on a hostname of its own: the
# template's own CreateDistribution path. Its default behaviour goes to the site bucket, which refuses it (403); the
# cases only use /_sid/*.
deploy_function "$prefix-edge-conformance" '{"SID_COOKIE_DOMAIN":"host-only"}' origin-request \
  CreateDistribution=true "SiteOriginDomainName=$(output "$prefix-edge-site" BucketRegionalDomainName)"

# The test site: the page and the Prebid.js bundle, as on the regional test site.
(cd "$repo_root" && npm run bundle-prebid --prefix e2e >/dev/null)
bucket="$(output "$prefix-edge-site" BucketName)"
distribution="$(output "$prefix-edge-site" DistributionId)"
(cd "$repo_root" && "$aws" s3 sync e2e/site/public "s3://$bucket" --delete --no-progress)
invalidation="$("$aws" cloudfront create-invalidation --distribution-id "$distribution" --paths '/*' --query Invalidation.Id --output text)"
echo "Waiting for invalidation $invalidation"
"$aws" cloudfront wait invalidation-completed --distribution-id "$distribution" --id "$invalidation"

conformance_domain="$(output "$prefix-edge-conformance" DistributionDomainName)"
echo "Site:        https://$domain/"
echo "Conformance: https://$conformance_domain/_sid"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "site=https://$domain"
    echo "cookie-domain=$domain"
    echo "conformance=https://$conformance_domain"
    echo "distribution=$distribution"
  } >> "$GITHUB_OUTPUT"
fi
