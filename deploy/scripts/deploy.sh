#!/usr/bin/env bash
# deploy.sh
#
# Pull latest code, install dependencies, and reload PM2 processes.
# Run from the repo root on the VPS, or call from GitHub Actions.
#
#   bash deploy/scripts/deploy.sh
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

echo "════════════════════════════════════════"
echo " takerbot Deploy"
echo " Repo: $REPO_DIR"
echo "════════════════════════════════════════"

cd "$REPO_DIR"

# ── Pull latest ───────────────────────────────────────────────────────────────
echo "[1/4] pulling latest code…"
git pull origin "$(git rev-parse --abbrev-ref HEAD)"

# ── Install dependencies ──────────────────────────────────────────────────────
echo "[2/4] installing dependencies…"
pnpm install --frozen-lockfile

# ── Validate .env ─────────────────────────────────────────────────────────────
echo "[3/4] validating .env…"
if [ ! -f .env ]; then
  echo "ERROR: .env file not found!"
  echo "       Copy deploy/.env.example to .env and fill in your credentials."
  exit 1
fi

if grep -q "^PRIVATE_KEY=0x\.\.\." .env 2>/dev/null; then
  echo "ERROR: PRIVATE_KEY not set in .env (still has placeholder value)"
  exit 1
fi

# ── Reload PM2 ────────────────────────────────────────────────────────────────
echo "[4/4] reloading PM2 processes…"
if pm2 describe takerbot > /dev/null 2>&1; then
  pm2 reload takerbot/ecosystem.config.cjs --env production
else
  pm2 start takerbot/ecosystem.config.cjs --env production
fi

pm2 save

echo ""
echo "════════════════════════════════════════"
echo " Deploy complete!"
echo " Run 'pm2 logs' to monitor processes."
echo "════════════════════════════════════════"
