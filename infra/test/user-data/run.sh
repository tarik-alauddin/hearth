#!/bin/bash
# Tests user-data/game-instance.sh in a privileged Amazon Linux 2023 container,
# against a file-backed loop device standing in for the EBS data volume. Requires Docker.
set -euo pipefail

here=$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))
export MSYS_NO_PATHCONV=1 # Git Bash on Windows: don't rewrite the container paths below

docker run --rm --privileged \
  -v "$here/../../lib/user-data:/work:ro" \
  -v "$here:/test:ro" \
  public.ecr.aws/amazonlinux/amazonlinux:2023 \
  bash /test/in-container.sh
