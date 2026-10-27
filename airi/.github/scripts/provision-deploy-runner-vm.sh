#!/usr/bin/env bash
# Create a small GCP VM intended for the GitHub Actions deploy self-hosted runner.
#
# Usage:
#   export GCP_PROJECT_ID=your-project
#   export GCP_ZONE=us-central1-a          # optional
#   export GCP_RUNNER_VM_NAME=airi-gha-deploy
#   bash .github/scripts/provision-deploy-runner-vm.sh
#
# After VM is up, SSH in and run setup-self-hosted-runner.sh with a registration token.

set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
ZONE="${GCP_ZONE:-$(gcloud config get-value compute/zone 2>/dev/null || true)}"
ZONE="${ZONE:-us-central1-a}"
VM_NAME="${GCP_RUNNER_VM_NAME:-airi-gha-deploy}"
MACHINE_TYPE="${GCP_RUNNER_MACHINE_TYPE:-e2-standard-2}"
DISK_SIZE_GB="${GCP_RUNNER_DISK_GB:-50}"
IMAGE_FAMILY="${GCP_RUNNER_IMAGE_FAMILY:-ubuntu-2204-lts}"
IMAGE_PROJECT="${GCP_RUNNER_IMAGE_PROJECT:-ubuntu-os-cloud}"

echo "Creating (or reusing) VM ${VM_NAME} in ${PROJECT_ID}/${ZONE} (${MACHINE_TYPE})..."

if gcloud compute instances describe "${VM_NAME}" --project="${PROJECT_ID}" --zone="${ZONE}" >/dev/null 2>&1; then
  echo "VM already exists."
else
  gcloud compute instances create "${VM_NAME}" \
    --project="${PROJECT_ID}" \
    --zone="${ZONE}" \
    --machine-type="${MACHINE_TYPE}" \
    --image-family="${IMAGE_FAMILY}" \
    --image-project="${IMAGE_PROJECT}" \
    --boot-disk-size="${DISK_SIZE_GB}GB" \
    --boot-disk-type=pd-balanced \
    --scopes=cloud-platform \
    --tags=github-actions-runner \
    --metadata=enable-oslogin=TRUE
fi

cat <<EOF

VM ready.

Next (on the VM):
  1. gcloud compute ssh ${VM_NAME} --project=${PROJECT_ID} --zone=${ZONE}
  2. Install Node 24 + pnpm + git:
       curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
       sudo apt-get install -y nodejs git curl tar
       sudo corepack enable && sudo corepack prepare pnpm@latest --activate
  3. Copy or clone the repo, then:
       export RUNNER_URL=https://github.com/OWNER/REPO
       export RUNNER_TOKEN=...   # from GitHub → Settings → Actions → Runners → New self-hosted runner
       bash .github/scripts/setup-self-hosted-runner.sh
  4. In GitHub repo variables, set:
       DEPLOY_RUNS_ON = ["self-hosted","linux","deploy"]

EOF
