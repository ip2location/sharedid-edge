#!/usr/bin/env bash
# Deploys the live tests' EU visitor (README.md, Live tests; live/eu-visitor.yaml): the function sharedid-eu-visitor in
# eu-central-1, which scripts/check-eu-visitor.ts invokes to request the live setups from a German address. Not for
# deployers.
#
#   packages/adapters/aws-lambda/live/eu-visitor.sh
#
# Uses the AWS CLI's usual credentials (AWS_PROFILE, or the workflow's OIDC role), with live/iam-policy.json's
# eu-central-1 statements. Creates or updates the stack sharedid-eu-visitor (SID_EU_VISITOR_STACK): the function and
# its execution role, which has no permissions. Idempotent: with nothing changed, it changes nothing. The function's
# code is inline in the template, so there's no bucket.
set -euo pipefail

# Git Bash on Windows: don't turn arguments into Windows paths for aws.exe.
export MSYS_NO_PATHCONV=1
export AWS_REGION="${SID_EU_VISITOR_REGION:-eu-central-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"
aws="${AWS_CLI:-aws}"
stack="${SID_EU_VISITOR_STACK:-sharedid-eu-visitor}"

cd "$(dirname "$0")"
echo "Deploying $stack in $AWS_REGION"
"$aws" cloudformation deploy --stack-name "$stack" --template-file eu-visitor.yaml \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
  --tags project=sharedid-edge purpose=live-tests
"$aws" lambda wait function-updated-v2 --function-name sharedid-eu-visitor
echo "Function: sharedid-eu-visitor ($AWS_REGION)"
