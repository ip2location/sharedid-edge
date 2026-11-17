#!/usr/bin/env bash
# Deploys this project's upstream-operator live test (README.md, The upstream-operator and Cloudflare for SaaS setups;
# docs/upstream-operators.md): SharedID Edge as an upstream operator's endpoint in trusted-upstream mode, and publishers
# in front of it. Not for deployers.
#
#   npm ci && npm run build && npm ci --prefix e2e      # first
#   UO_ENDPOINT_HOST=sid.upstream.example \
#   UO_CLOUDFRONT_PUBLISHER_HOST=pub.publisher.example UO_CLOUDFRONT_COOKIE_DOMAIN=publisher.example \
#   UO_ROUTE53_ZONE_ID=<the publisher domain's hosted zone> \
#   UO_CLOUDFLARE_PUBLISHER_HOST=pub2.test-zone.example UO_CLOUDFLARE_COOKIE_DOMAIN=test-zone.example \
#   UO_CLOUDFLARE_CONFORMANCE_HOST=pub3.test-zone.example UO_CLOUDFLARE_PUBLISHER_ZONE=test-zone.example \
#   UO_SECRETS_DIR=<a private folder outside the repository> \
#   packages/adapters/cloudflare/live/upstream.sh [workers|cloudfront]   # both by default
#
# It deploys, with Wrangler (logged in, or CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID):
#
#   sharedid-saleshouse           This package's Worker on the custom domain UO_ENDPOINT_HOST (a hostname of a zone in
#                                 the account), with SID_UPSTREAM_SECRETS and the publishers in SID_HOSTS
#   sharedid-saleshouse-forward   Publishers on Cloudflare: forward.js, docs/upstream-operators.md's Cloudflare recipe, on
#                                 UO_CLOUDFLARE_PUBLISHER_HOST/_sid/* (the e2e settings, with cookies on
#                                 UO_CLOUDFLARE_COOKIE_DOMAIN) and, optionally, UO_CLOUDFLARE_CONFORMANCE_HOST/_sid/*
#                                 (the default settings, for the conformance suite). Both are proxied records of
#                                 UO_CLOUDFLARE_PUBLISHER_ZONE, in the account. Skipped when UO_CLOUDFLARE_PUBLISHER_HOST
#                                 is unset.
#
# and, with the AWS CLI (AWS_PROFILE; us-east-1, where CloudFront's certificates live), the stack
# UO_STACK (default sharedid-saleshouse-pub) from publisher-cloudfront.yaml: UO_CLOUDFRONT_PUBLISHER_HOST on CloudFront,
# with the e2e test page and the recipe's /_sid/* behaviour. Then it uploads the page and its Prebid.js bundle.
#
# The secrets, one per publisher CDN, are UO_SECRETS_DIR/upstream-secret-cloudfront and upstream-secret-cloudflare; it
# creates them (openssl rand -hex 32) when they're missing, except in CI (CI=true, as on GitHub Actions), where a
# missing one is an error: a new secret would lock out the publisher whose CDN still sends the old one. Both parts need
# both, since the endpoint takes both. They're never printed. Every resource is named sharedid-*.
#
# UO_ROUTE53_ZONE_ID and the AWS CLI are needed only for the cloudfront part. The workflow e2e-upstream.yml runs it
# after every merge to main and nightly, then scripts/check-live-site.ts.
set -euo pipefail
case "${1:-}" in
  -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
esac
parts="${1:-workers cloudfront}"
for part in $parts; do
  case "$part" in workers|cloudfront) ;; *) echo "Unknown part: $part (workers, cloudfront)" >&2; exit 2 ;; esac
done

export MSYS_NO_PATHCONV=1
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
aws="${AWS_CLI:-aws}"
stack="${UO_STACK:-sharedid-saleshouse-pub}"
: "${UO_ENDPOINT_HOST:?}" "${UO_CLOUDFRONT_PUBLISHER_HOST:?}" "${UO_CLOUDFRONT_COOKIE_DOMAIN:?}" "${UO_SECRETS_DIR:?}"
[[ " $parts " != *" cloudfront "* ]] || : "${UO_ROUTE53_ZONE_ID:?}"
export UO_ENDPOINT_HOST UO_CLOUDFRONT_PUBLISHER_HOST UO_CLOUDFRONT_COOKIE_DOMAIN
export UO_CLOUDFLARE_PUBLISHER_HOST="${UO_CLOUDFLARE_PUBLISHER_HOST:-}" UO_CLOUDFLARE_PUBLISHER_ZONE="${UO_CLOUDFLARE_PUBLISHER_ZONE:-}"
export UO_CLOUDFLARE_COOKIE_DOMAIN="${UO_CLOUDFLARE_COOKIE_DOMAIN:-}" UO_CLOUDFLARE_CONFORMANCE_HOST="${UO_CLOUDFLARE_CONFORMANCE_HOST:-}"

package_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_root="$(cd "$package_dir/../../.." && pwd)"
cd "$package_dir"

mkdir -p "$UO_SECRETS_DIR"
for publisher in cloudfront cloudflare; do
  [ -s "$UO_SECRETS_DIR/upstream-secret-$publisher" ] && continue
  if [ "${CI:-}" = true ]; then
    echo "Missing $UO_SECRETS_DIR/upstream-secret-$publisher; not creating one in CI" >&2
    exit 1
  fi
  (umask 077 && openssl rand -hex 32 > "$UO_SECRETS_DIR/upstream-secret-$publisher")
done
cloudfront_secret="$(cat "$UO_SECRETS_DIR/upstream-secret-cloudfront")"
cloudflare_secret="$(cat "$UO_SECRETS_DIR/upstream-secret-cloudflare")"
# Wrangler's --secrets-file, uploaded with the Worker's version, so it never runs without them; removed afterwards.
secrets_file="$UO_SECRETS_DIR/.wrangler-secrets.json"
trap 'rm -f "$secrets_file"' EXIT
# Wrangler on Windows (Git Bash) needs a Windows path.
secrets_arg="$secrets_file"
! command -v cygpath >/dev/null || secrets_arg="$(cygpath -w "$secrets_file")"

if [[ " $parts " == *" workers "* ]]; then
  node live/configs.mjs upstream

  echo "Deploying the upstream-operator endpoint on https://$UO_ENDPOINT_HOST"
  (umask 077 && printf '{"SID_UPSTREAM_SECRETS":"[\\"%s\\",\\"%s\\"]"}' "$cloudfront_secret" "$cloudflare_secret" > "$secrets_file")
  npx wrangler deploy --config live/.out/endpoint.json --secrets-file "$secrets_arg"

  if [ -n "$UO_CLOUDFLARE_PUBLISHER_HOST" ]; then
    echo "Deploying the Cloudflare publisher on https://$UO_CLOUDFLARE_PUBLISHER_HOST/_sid/*"
    (umask 077 && printf '{"SID_UPSTREAM_SECRET":"%s"}' "$cloudflare_secret" > "$secrets_file")
    npx wrangler deploy --config live/.out/forward.json --secrets-file "$secrets_arg"
  fi
  rm -f "$secrets_file"
fi

if [[ " $parts " == *" cloudfront "* ]]; then
  # UO_CLOUDFRONT_FORWARD=false deploys the site without the recipe's function and /_sid/* behaviour, for an account
  # that can't create CloudFront Functions yet.
  forward="${UO_CLOUDFRONT_FORWARD:-true}"
  echo "Deploying $stack: https://$UO_CLOUDFRONT_PUBLISHER_HOST on CloudFront (forwarding /_sid/*: $forward)"
  "$aws" cloudformation deploy --stack-name "$stack" --template-file live/publisher-cloudfront.yaml \
    --no-fail-on-empty-changeset --tags project=sharedid-edge purpose=live-tests \
    --parameter-overrides "PublisherHostName=$UO_CLOUDFRONT_PUBLISHER_HOST" "HostedZoneId=$UO_ROUTE53_ZONE_ID" \
    "EndpointHostName=$UO_ENDPOINT_HOST" "UpstreamSecret=$cloudfront_secret" "ForwardSid=$forward" >/dev/null

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

echo "Endpoint:               https://$UO_ENDPOINT_HOST/_sid (403 without the secret)"
echo "Publisher (CloudFront): https://$UO_CLOUDFRONT_PUBLISHER_HOST/"
[ -z "$UO_CLOUDFLARE_PUBLISHER_HOST" ] || echo "Publisher (Cloudflare): https://$UO_CLOUDFLARE_PUBLISHER_HOST/_sid"
