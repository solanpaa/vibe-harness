#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="${1:-vibe-harness/copilot:latest}"

echo "Building $IMAGE_NAME …"
docker build -t "$IMAGE_NAME" -f "$SCRIPT_DIR/Dockerfile.copilot" "$SCRIPT_DIR"
echo "Done. Use with:  docker sandbox run -t $IMAGE_NAME copilot ."
