#!/usr/bin/env bash
# Constrói a imagem da sandbox do Aurex.
set -euo pipefail
IMAGE="${AUREX_SANDBOX_IMAGE:-aurex/sandbox:1}"
cd "$(dirname "$0")"
echo "Construindo $IMAGE (leva alguns minutos na primeira vez)..."
docker build -t "$IMAGE" .
echo "Pronto: $IMAGE"
