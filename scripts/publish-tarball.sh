#!/usr/bin/env bash
# Publishes one packed tarball for the publish workflow (.github/workflows/publish.yml).
#
#   scripts/publish-tarball.sh <tarball.tgz> <commit>
#
# <commit> is the commit the tarball was packed from (the build job's `head`
# output, also written into the tarball as gitHead). Environment: DRY_RUN
# ("true" adds --dry-run) and DIST_TAG (passed as --tag).
#
# Idempotent, so that "Re-run failed jobs" on the publish job can finish a
# release. That re-run reuses the build job's plan and tarballs, so it can be
# asked to publish a version an earlier attempt already published:
# - Already on npm with gitHead == <commit>: an earlier attempt of this run
#   published it. Skip, with a notice.
# - Already on npm with another (or no) gitHead: something else published that
#   version. Fail; a new dispatch re-plans and says what to bump.
# - Not on npm: publish. In a dry run, also fail unless npm's OIDC token
#   exchange worked, i.e. the trusted publisher is configured.
#
# No NODE_AUTH_TOKEN: npm swaps the job's OIDC token for a short-lived publish
# token (trusted publishing). Provenance comes from the job's GitHub context, so
# it names this repo, workflow and commit although another job packed the file.
set -euo pipefail

tarball=${1:?usage: publish-tarball.sh <tarball.tgz> <commit>}
commit=${2:?usage: publish-tarball.sh <tarball.tgz> <commit>}
: "${DIST_TAG:?DIST_TAG must be set}"
dry_run=${DRY_RUN:-true}

manifest=$(tar -xOzf "$tarball" package/package.json)
name=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).name)' "$manifest")
version=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).version)' "$manifest")
spec="$name@$version"

# Is this version already on npm? E404 (the package doesn't exist at all) means
# no; any other registry error fails rather than guessing.
err=$(mktemp)
if existing=$(npm view "$spec" version 2>"$err"); then
  :
elif grep -q 'E404' "$err"; then
  existing=""
else
  cat "$err" >&2
  echo "::error::npm view $spec failed; not publishing."
  exit 1
fi

if [ -n "$existing" ]; then
  published_head=$(npm view "$spec" gitHead)
  if [ "$published_head" = "$commit" ]; then
    echo "::notice::$spec is already on npm, published from this commit ($commit) by an earlier attempt. Skipping."
    exit 0
  fi
  from=${published_head:-"a commit npm did not record"}
  echo "::error::$spec is already on npm, published from $from, not this run's commit $commit. Start a new dispatch so the plan can say what to bump."
  exit 1
fi

args=(--ignore-scripts --provenance --access public --tag "$DIST_TAG" --loglevel verbose)
if [ "$dry_run" = "true" ]; then args+=(--dry-run); fi
log=$(mktemp)
npm publish "$tarball" "${args[@]}" 2>&1 | tee "$log"

# npm logs this line only if the OIDC exchange worked; it does the exchange in a
# dry run too, so a dry run can check the trusted-publisher setup.
if [ "$dry_run" = "true" ] && ! grep -q "oidc Successfully retrieved and set token" "$log"; then
  echo "::error::npm could not exchange this job's OIDC token for $name. Configure its trusted publisher on npmjs.com (README → Releasing); a real run would fail to publish."
  exit 1
fi
