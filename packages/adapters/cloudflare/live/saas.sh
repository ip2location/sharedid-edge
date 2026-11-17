#!/usr/bin/env bash
# Deploys this project's Cloudflare for SaaS live test (README.md, Live tests; docs/hosting-companies.md): a hosting
# company's SaaS zone serving a publisher's custom hostname, whose DNS is elsewhere (Route 53), with SharedID Edge on
# the zone's */_sid/* route. Not for deployers.
#
#   npm ci && npm run build && npm ci --prefix e2e      # first
#   SAAS_ZONE=saas-zone.example SAAS_FALLBACK_ORIGIN=fallback.saas-zone.example \
#   SAAS_HOSTNAME=saas.publisher.example SAAS_COOKIE_DOMAIN=publisher.example \
#   SAAS_UNLISTED_HOSTNAME=saas2.publisher.example SAAS_ROUTE53_ZONE_ID=<the publisher domain's hosted zone> \
#   packages/adapters/cloudflare/live/saas.sh [setup|workers]   # both by default
#
# Cloudflare for SaaS must be enabled on SAAS_ZONE first (dashboard: SSL/TLS, Custom Hostnames; the API can't). It
# uses the cf CLI (logged in, or CLOUDFLARE_API_TOKEN) for the zone, Wrangler for the Workers and the AWS CLI
# (AWS_PROFILE) for the publisher's DNS:
#
#   SAAS_FALLBACK_ORIGIN          A proxied AAAA 100:: record, the zone's fallback origin (the Workers answer)
#   SAAS_HOSTNAME                 A custom hostname, listed in the Worker's SID_HOSTS (cookie domain SAAS_COOKIE_DOMAIN)
#   SAAS_UNLISTED_HOSTNAME        Optional: a custom hostname that isn't, which must get a 404
#   Route 53                      Each custom hostname's CNAME to the fallback origin, and its ownership and
#                                 certificate (DCV) TXT records
#   sharedid-saas                 This package's Worker on */_sid/* of the zone
#   sharedid-saas-site            The e2e test page and its Prebid.js bundle on the custom hostnames (the publisher's
#                                 pages)
#
# The setup part is everything but the Workers: the fallback origin, the custom hostnames and their Route 53 records,
# made once. The workers part deploys the two Workers only, with Wrangler; it needs SAAS_ZONE, SAAS_HOSTNAME and
# SAAS_COOKIE_DOMAIN, not the cf or AWS CLI, nor custom-hostname permissions. The workflow e2e-upstream.yml runs it
# after every merge to main and nightly, then scripts/check-live-site.ts.
set -euo pipefail
case "${1:-}" in
  -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
esac
parts="${1:-setup workers}"
for part in $parts; do
  case "$part" in setup|workers) ;; *) echo "Unknown part: $part (setup, workers)" >&2; exit 2 ;; esac
done

export MSYS_NO_PATHCONV=1
aws="${AWS_CLI:-aws}"
: "${SAAS_ZONE:?}" "${SAAS_HOSTNAME:?}" "${SAAS_COOKIE_DOMAIN:?}"
[[ " $parts " != *" setup "* ]] || : "${SAAS_FALLBACK_ORIGIN:?}" "${SAAS_ROUTE53_ZONE_ID:?}"
export SAAS_ZONE SAAS_HOSTNAME SAAS_COOKIE_DOMAIN SAAS_UNLISTED_HOSTNAME="${SAAS_UNLISTED_HOSTNAME:-}"

package_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_root="$(cd "$package_dir/../../.." && pwd)"
cd "$package_dir"

# Reads a JSON document on stdin and prints the value of the JavaScript expression $1 over it (as `j`).
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const v=($1);if(v!==undefined&&v!==null)console.log(v)})"; }

if [[ " $parts " == *" setup "* ]]; then
  if [ -z "$(cf dns records list -z "$SAAS_ZONE" --name-exact "$SAAS_FALLBACK_ORIGIN" | json 'j.map(r=>r.id).join(" ")')" ]; then
    echo "Creating the fallback origin's record, $SAAS_FALLBACK_ORIGIN"
    cf dns records create -z "$SAAS_ZONE" --body "{\"type\":\"AAAA\",\"name\":\"$SAAS_FALLBACK_ORIGIN\",\"content\":\"100::\",\"proxied\":true}" >/dev/null
  fi
  cf custom-hostnames fallback-origin update -z "$SAAS_ZONE" --body "{\"origin\":\"$SAAS_FALLBACK_ORIGIN\"}" >/dev/null

  # Creates the custom hostname (TXT validation, so its certificate can be issued before traffic moves) and writes its
  # DNS records on the publisher's side. Run again to pick up validation records that weren't ready yet.
  custom_hostname() {
    local host="$1" id details changes
    id="$(cf custom-hostnames list -z "$SAAS_ZONE" --hostname "$host" | json "(j.find(h=>h.hostname==='$host')||{}).id")"
    if [ -z "$id" ]; then
      echo "Creating the custom hostname $host"
      id="$(cf custom-hostnames create -z "$SAAS_ZONE" --body "{\"hostname\":\"$host\",\"ssl\":{\"method\":\"txt\",\"type\":\"dv\"}}" | json 'j.id')"
    fi
    details="$(cf custom-hostnames get "$id" -z "$SAAS_ZONE")"
    # One record set per name and type: certificate validation can need two TXT values on one name.
    changes="$(printf '%s' "$details" | json "JSON.stringify({Changes:Object.values([
      {name:'$host',type:'CNAME',value:'$SAAS_FALLBACK_ORIGIN'},
      j.ownership_verification&&{name:j.ownership_verification.name,type:'TXT',value:JSON.stringify(j.ownership_verification.value)},
      ...((j.ssl&&j.ssl.validation_records)||[]).filter(r=>r.txt_name).map(r=>({name:r.txt_name,type:'TXT',value:JSON.stringify(r.txt_value)}))
    ].filter(Boolean).reduce((sets,r)=>{const key=r.name+' '+r.type;(sets[key]??={Name:r.name,Type:r.type,TTL:300,ResourceRecords:[]}).ResourceRecords.push({Value:r.value});return sets},{})).map(set=>({Action:'UPSERT',ResourceRecordSet:set}))})")"
    "$aws" route53 change-resource-record-sets --hosted-zone-id "$SAAS_ROUTE53_ZONE_ID" --change-batch "$changes" >/dev/null
    printf '%s' "$details" | json "'$host: '+j.status+', certificate '+(j.ssl&&j.ssl.status)"
  }
  custom_hostname "$SAAS_HOSTNAME"
  [ -z "$SAAS_UNLISTED_HOSTNAME" ] || custom_hostname "$SAAS_UNLISTED_HOSTNAME"
fi

[[ " $parts " == *" workers "* ]] || exit 0
node live/configs.mjs saas
npx wrangler deploy --config live/.out/saas.json
# The test page's Prebid.js bundle, as on e2e.sharedid.dev.
(cd "$repo_root" && npm run bundle-prebid --prefix e2e >/dev/null)
npx wrangler deploy --config live/.out/saas-site.json

echo "Site: https://$SAAS_HOSTNAME/ (once its certificate is active)"
