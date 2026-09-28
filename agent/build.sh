#!/bin/bash
# Builds the agent for game instances (Linux on Graviton) into agent/bin/hearth-agent.
# Usage: agent/build.sh [version]   (default: git describe)
set -euo pipefail
cd "$(dirname "$0")"

version=${1:-$(git describe --always --dirty 2>/dev/null || echo dev)}
mkdir -p bin
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 \
  go build -trimpath -ldflags "-s -w -X main.version=$version" -o bin/hearth-agent ./cmd/hearth-agent
echo "built agent/bin/hearth-agent ($version)"
