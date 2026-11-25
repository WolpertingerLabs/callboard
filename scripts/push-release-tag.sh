#!/usr/bin/env bash
# Creates and pushes one annotated release tag for the publish workflow.
#
#   scripts/push-release-tag.sh <tag> <commit> <message>
#
# Idempotent against the remote, so a re-run (of the whole run or just the
# publish job) can finish a release whose tag push already happened:
# - The tag is already on origin at <commit>: nothing to do.
# - The tag is on origin at another commit: fail; something else moved it.
# - Otherwise: tag <commit> as github-actions[bot] and push.
set -euo pipefail

tag=${1:?usage: push-release-tag.sh <tag> <commit> <message>}
commit=${2:?usage: push-release-tag.sh <tag> <commit> <message>}
message=${3:?usage: push-release-tag.sh <tag> <commit> <message>}

# ls-remote prints an annotated tag twice: the tag object, then "<commit>
# refs/tags/<tag>^{}" peeled. Prefer the peeled line; a lightweight tag has
# only the first.
remote=$(git ls-remote --tags origin "refs/tags/$tag" "refs/tags/$tag^{}")
at=$(awk -v t="refs/tags/$tag^{}" '$2 == t { print $1 }' <<<"$remote")
if [ -z "$at" ]; then at=$(awk '{ print $1; exit }' <<<"$remote"); fi

if [ -n "$at" ]; then
  if [ "$at" = "$commit" ]; then
    echo "::notice::$tag is already on origin at $commit. Nothing to do."
    exit 0
  fi
  echo "::error::$tag is already on origin at $at, not $commit. Not moving it."
  exit 1
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
# -f: a stale local tag (none is expected in a fresh checkout) must not block
# the push; the remote was just checked.
git tag -f -a "$tag" -m "$message" "$commit"
git push origin "refs/tags/$tag"
