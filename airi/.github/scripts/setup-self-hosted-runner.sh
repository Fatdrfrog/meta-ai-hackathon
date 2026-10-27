#!/usr/bin/env bash
# Install a GitHub Actions self-hosted runner for the Temporal deploy workflow.
#
# Prereqs:
#   - Linux VM (Ubuntu 22.04+ recommended) with sudo
#   - Registration token from:
#       Repo → Settings → Actions → Runners → New self-hosted runner
#     Or: gh api -X POST repos/OWNER/REPO/actions/runners/registration-token
#
# Usage:
#   export RUNNER_TOKEN=...          # required, short-lived
#   export RUNNER_URL=https://github.com/OWNER/REPO
#   export RUNNER_NAME=airi-deploy-1 # optional
#   export RUNNER_LABELS=linux,deploy
#   export RUNNER_DIR=$HOME/actions-runner
#   bash .github/scripts/setup-self-hosted-runner.sh
#
# Then set GitHub repo variable:
#   DEPLOY_RUNS_ON = ["self-hosted","linux","deploy"]
#
# Soft deps the deploy job needs on the VM (install if missing):
#   node 24+, pnpm, git, curl, tar, docker (optional; Cloud Build builds the image)

set -euo pipefail

RUNNER_URL="${RUNNER_URL:?Set RUNNER_URL to https://github.com/OWNER/REPO}"
RUNNER_TOKEN="${RUNNER_TOKEN:?Set RUNNER_TOKEN from GitHub runner registration token}"
RUNNER_NAME="${RUNNER_NAME:-airi-deploy-$(hostname -s)}"
RUNNER_LABELS="${RUNNER_LABELS:-linux,deploy}"
RUNNER_DIR="${RUNNER_DIR:-${HOME}/actions-runner}"
RUNNER_VERSION="${RUNNER_VERSION:-2.335.1}"

arch="$(uname -m)"
case "${arch}" in
  x86_64) runner_arch="x64" ;;
  aarch64|arm64) runner_arch="arm64" ;;
  *)
    echo "Unsupported arch: ${arch}" >&2
    exit 1
    ;;
esac

mkdir -p "${RUNNER_DIR}"
cd "${RUNNER_DIR}"

if [[ ! -f ./config.sh ]]; then
  tarball="actions-runner-linux-${runner_arch}-${RUNNER_VERSION}.tar.gz"
  curl -fsSL -o "${tarball}" \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${runner_arch}-${RUNNER_VERSION}.tar.gz"
  tar xzf "${tarball}"
  rm -f "${tarball}"
fi

if [[ ! -f .runner ]]; then
  ./config.sh \
    --unattended \
    --url "${RUNNER_URL}" \
    --token "${RUNNER_TOKEN}" \
    --name "${RUNNER_NAME}" \
    --labels "${RUNNER_LABELS}" \
    --work "_work"
fi

if command -v systemctl >/dev/null 2>&1; then
  if [[ ! -f ./svc.sh ]]; then
    echo "Runner svc.sh missing; install completed but service helper not found." >&2
    exit 1
  fi
  sudo ./svc.sh install
  sudo ./svc.sh start
  sudo ./svc.sh status || true
  echo "Runner installed as a systemd service."
else
  echo "No systemd — start in foreground with: cd ${RUNNER_DIR} && ./run.sh"
fi

echo ""
echo "Next:"
echo "  1. Confirm runner Idle under Repo → Settings → Actions → Runners"
echo "  2. Set repo variable DEPLOY_RUNS_ON to: [\"self-hosted\",\"linux\",\"deploy\"]"
echo "  3. Re-run Deploy Temporal Worker (workflow_dispatch) or merge to main"
