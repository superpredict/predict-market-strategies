#!/usr/bin/env bash
# deploy.sh
#
# Pull latest code, install dependencies, and apply the PM2 ecosystem (delete + start).
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

# if grep -q "^PRIVATE_KEY=0x\.\.\." .env 2>/dev/null; then
#   echo "ERROR: PRIVATE_KEY not set in .env (still has placeholder value)"
#   exit 1
# fi

# ── PM2: replace process list from ecosystem ──────────────────────────────────
# `pm2 reload` can keep a stale `pm_exec_path` (e.g. still pointing at
# `node_modules/.bin/tsx` after ecosystem changes). Delete apps declared in the
# current file, then start fresh so script/interpreter updates always apply.
echo "[4/4] applying PM2 ecosystem…"
ECOSYSTEM="takerbot/ecosystem.config.cjs"
node deploy/scripts/verify-pm2-ecosystem.cjs
APP_NAMES="$(
  node -e "
    const e = require('./$ECOSYSTEM');
    if (!e.apps?.length) process.exit(0);
    process.stdout.write(e.apps.map((a) => a.name).join(' '));
  "
)"
if [ -n "${APP_NAMES:-}" ]; then
  # shellcheck disable=SC2086
  pm2 delete $APP_NAMES 2>/dev/null || true
fi
pm2 start "$ECOSYSTEM" --env production

pm2 save

echo ""
echo "════════════════════════════════════════"
echo " Deploy complete!"
echo " Run 'pm2 logs' to monitor processes."
echo "════════════════════════════════════════"
