#!/bin/sh
#
# Double-click launcher for Freebuff AdBlock for Desktop.
#
# Kept next to freebuff-adblock.sh inside the downloaded zip. Double-clicking
# this file opens Terminal and runs the patch; the window stays open afterwards
# so the output can be read.
#
# If macOS refuses to open it, either right-click -> Open, or run the tool
# directly:
#   sh freebuff-adblock.sh install

cd "$(dirname "$0")" || exit 1

sh ./freebuff-adblock.sh install

printf '\n'
printf 'Press Return to close this window. '
read -r _ 2>/dev/null || true
