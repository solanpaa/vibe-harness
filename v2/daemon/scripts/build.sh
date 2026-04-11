#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Building daemon for production..."
npm run build

echo "Daemon built at .output/server/index.mjs"
