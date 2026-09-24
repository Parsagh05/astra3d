#!/bin/sh
# Production entrypoint.  The data folders are bind-mounted from the host, and
# Docker creates missing ones owned by root, so hand them to the unprivileged
# `node` user before starting the server as that user.
set -e

if [ "$(id -u)" = "0" ]; then
  for dir in "$ASTRA3D_DATA_DIR" "$ASTRA3D_TEST_CASES_DIR"; do
    [ -n "$dir" ] || continue
    mkdir -p "$dir"
    if ! setpriv --reuid=node --regid=node --init-groups test -w "$dir"; then
      chown -R node:node "$dir"
    fi
  done
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
