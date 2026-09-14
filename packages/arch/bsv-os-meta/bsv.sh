#!/bin/sh
# bsv CLI launcher (installed by bsv-os-meta)
exec /usr/bin/node /usr/lib/bsv-os/walletd/dist/cli.js "$@"
