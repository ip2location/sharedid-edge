#!/usr/bin/env bash
# Deploys this project's sales-house live test (README.md, The sales-house and Cloudflare for SaaS setups;
# docs/sales-houses.md): SharedID Edge as a sales house's endpoint in trusted-upstream mode, and publishers in front of
# it. Not for deployers.
#
#   npm ci && npm run build && npm ci --prefix e2e      # first
#   SH_ENDPOINT_HOST=sid.saleshouse.example \
#   SH_CLOUDFRONT_PUBLISHER_HOST=pub.publisher.example SH_CLOUDFRONT_COOKIE_DOMAIN=publisher.example \
#   SH_ROUTE53_ZONE_ID=<the publisher domain's hosted zone> \
#   SH_CLOUDFLARE_PUBLISHER_HOST=pub2.test-zone.example SH_CLOUDFLARE_COOKIE_DOMAIN=test-zone.example \
#   SH_CLOUDFLARE_CONFORMANCE_HOST=pub3.test-zone.example SH_CLOUDFLARE_PUBLISHER_ZONE=test-zone.example \
#   SH_SECRETS_DIR=<a private folder outside the repository> \
#   packages/adapters/cloudflare/live/sales-house.sh [workers|cloudfront]   # both by default
#
# It deploys, with Wrangler (logged in, or CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID):
#
#   sharedid-saleshouse           This package's Worker on the custom domain SH_ENDPOINT_HOST (a hostname of a zone in
#                                 the account), with SID_UPSTREAM_SECRETS and the publishers in SID_HOSTS
#   sharedid-saleshouse-forward   Publishers on Cloudflare: forward.js, docs/sales-houses.md's Cloudflare recipe, on
#                                 SH_CLOUDFLARE_PUBLISHER_HOST/_sid/* (the e2e settings, with cookies on
#                                 SH_CLOUDFLARE_COOKIE_DOMAIN) and, optionally, SH_CLOUDFLARE_CONFORMANCE_HOST/_sid/*
#                                 (the default settings, for the conformance suite). Both are proxied records of
#                                 SH_CLOUDFLARE_PUBLISHER_ZONE, in the account. Skipped when SH_CLOUDFLARE_PUBLISHER_HOST
#                                 is unset.
#
# and, with the AWS CLI (AWS_PROFILE; us-east-1, where CloudFront's certificates live), the stack
# SH_STACK (default sharedid-saleshouse-pub) from publisher-cloudfront.yaml: SH_CLOUDFRONT_PUBLISHER_HOST on CloudFront,
# with the e2e test page and the recipe's /_sid/* behaviour. Then it uploads the page and its Prebid.js bundle.
#
# The secrets, one per publisher CDN, are SH_SECRETS_DIR/upstream-secret-cloudfront and upstream-secret-cloudflare; it
# creates them (openssl rand -hex 32) when they're missing. They're never printed. Every resource is named sharedid-*.
set -euo pipefail
parts="${1:-workers cloudfront}"

export MSYS_NO_PATHCONV=1
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
aws="${AWS_CLI:-aws}"
stack="${SH_STACK:-sharedid-saleshouse-pub}"
: "${SH_ENDPOINT_HOST:?}" "${SH_CLOUDFRONT_PUBLISHER_HOST:?}" "${SH_CLOUDFRONT_COOKIE_DOMAIN:?}" "${SH_ROUTE53_ZONE_ID:?}" "${SH_SECRETS_DIR:?}"
export SH_ENDPOINT_HOST SH_CLOUDFRONT_PUBLISHER_HOST SH_CLOUDFRONT_COOKIE_DOMAIN
export SH_CLOUDFLARE_PUBLISHER_HOST="${SH_CLOUDFLARE_PUBLISHER_HOST:-}" SH_CLOUDFLARE_PUBLISHER_ZONE="${SH_CLOUDFLARE_PUBLISHER_ZONE:-}"
export SH_CLOUDFLARE_COOKIE_DOMAIN="${SH_CLOUDFLARE_COOKIE_DOMAIN:-}" SH_CLOUDFLARE_CONFORMANCE_HOST="${SH_CLOUDFLARE_CONFORMANCE_HOST:-}"

package_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_root="$(cd "$package_dir/../../.." && pwd)"
cd "$package_dir"

mkdir -p "$SH_SECRETS_DIR"
for publisher in cloudfront cloudflare; do
  [ -s "$SH_SECRETS_DIR/upstream-secret-$publisher" ] || (umask 077 && openssl rand -hex 32 > "$SH_SECRETS_DIR/upstream-secret-$publisher")
done
cloudfront_secret="$(cat "$SH_SECRETS_DIR/upstream-secret-cloudfront")"
cloudflare_secret="$(cat "$SH_SECRETS_DIR/upstream-secret-cloudflare")"
# Wrangler's --secrets-file, uploaded with the Worker's version, so it never runs without them; removed afterwards.
secrets_file="$SH_SECRETS_DIR/.wrangler-secrets.json"
trap 'rm -f "$secrets_file"' EXIT
# Wrangler on Windows (Git Bash) needs a Windows path.
secrets_arg="$secrets_file"
! command -v cygpath >/dev/null || secrets_arg="$(cygpath -w "$secrets_file")"

if [[ " $parts " == *" workers "* ]]; then
  node live/configs.mjs sales-house

  echo "Deploying the sales-house endpoint on https://$SH_ENDPOINT_HOST"
  (umask 077 && printf '{"SID_UPSTREAM_SECRETS":"[\\"%s\\",\\"%s\\"]"}' "$cloudfront_secret" "$cloudflare_secret" > "$secrets_file")
  npx wrangler deploy --config live/.out/endpoint.json --secrets-file "$secrets_arg"

  if [ -n "$SH_CLOUDFLARE_PUBLISHER_HOST" ]; then
    echo "Deploying the Cloudflare publisher on https://$SH_CLOUDFLARE_PUBLISHER_HOST/_sid/*"
    (umask 077 && printf '{"SID_UPSTREAM_SECRET":"%s"}' "$cloudflare_secret" > "$secrets_file")
    npx wrangler deploy --config live/.out/forward.json --secrets-file "$secrets_arg"
  fi
  rm -f "$secrets_file"
fi

if [[ " $parts " == *" cloudfront "* ]]; then
  # SH_CLOUDFRONT_FORWARD=false deploys the site without the recipe's function and /_sid/* behaviour, for an account
  # that can't create CloudFront Functions yet.
  forward="${SH_CLOUDFRONT_FORWARD:-true}"
  echo "Deploying $stack: https://$SH_CLOUDFRONT_PUBLISHER_HOST on CloudFront (forwarding /_sid/*: $forward)"
  "$aws" cloudformation deploy --stack-name "$stack" --template-file live/publisher-cloudfront.yaml \
    --no-fail-on-empty-changeset --tags project=sharedid-edge purpose=live-tests \
    --parameter-overrides "PublisherHostName=$SH_CLOUDFRONT_PUBLISHER_HOST" "HostedZoneId=$SH_ROUTE53_ZONE_ID" \
    "EndpointHostName=$SH_ENDPOINT_HOST" "UpstreamSecret=$cloudfront_secret" "ForwardSid=$forward" >/dev/null

  output() {
    "$aws" cloudformation describe-stacks --stack-name "$stack" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
  }
  (cd "$repo_root" && npm run bundle-prebid --prefix e2e >/dev/null)
  bucket="$(output BucketName)"
  distribution="$(output DistributionId)"
  (cd "$repo_root" && "$aws" s3 sync e2e/site/public "s3://$bucket" --delete --no-progress)
  invalidation="$("$aws" cloudfront create-invalidation --distribution-id "$distribution" --paths '/*' --query Invalidation.Id --output text)"
  echo "Waiting for invalidation $invalidation"
  "$aws" cloudfront wait invalidation-completed --distribution-id "$distribution" --id "$invalidation"
fi

echo "Endpoint:               https://$SH_ENDPOINT_HOST/_sid (403 without the secret)"
echo "Publisher (CloudFront): https://$SH_CLOUDFRONT_PUBLISHER_HOST/"
[ -z "$SH_CLOUDFLARE_PUBLISHER_HOST" ] || echo "Publisher (Cloudflare): https://$SH_CLOUDFLARE_PUBLISHER_HOST/_sid"
