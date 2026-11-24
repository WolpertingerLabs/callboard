#!/bin/sh
# profile-env FILE COMMAND [ARG...]: export each NAME=value line of FILE, then
# exec COMMAND. A sandbox profile's PATH and variables (Callboard writes FILE,
# /etc/computer-use/profile.env, from the validated recipe).
#
# Always run as the desktop user, never as root: start-desktop.sh calls it
# after dropping to `desktop`, and a profile build's setup step likewise. So
# even a malformed FILE can only affect the desktop user's own processes.
# Lines are read, never sourced: a value is exported verbatim, nothing in it
# is expanded or executed. A missing FILE (the base image) exports nothing.
set -eu
file="$1"
shift
if [ -r "$file" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; esac
    name="${line%%=*}"
    [ "$name" != "$line" ] || continue
    case "$name" in '' | [0-9]* | *[!A-Za-z0-9_]*)
      echo "profile-env: skipping a malformed line" >&2
      continue
      ;;
    esac
    export "$line"
  done < "$file"
fi
exec "$@"
