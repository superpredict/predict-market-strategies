#!/usr/bin/env bash
# setup-vps.sh
#
# One-time setup script for a fresh Ubuntu 22.04 / 24.04 VPS.
# Run as root or with sudo privileges.
#
#   bash deploy/scripts/setup-vps.sh
#
set -euo pipefail

echo "════════════════════════════════════════"
echo " takerbot VPS Setup"
echo "════════════════════════════════════════"

# ── System packages ─────────────────────────────────────────────────────────
echo "[1/7] updating system packages…"
apt-get update -y && apt-get upgrade -y
apt-get install -y curl git ufw

# ── Node.js 22 (via NodeSource) ──────────────────────────────────────────────
echo "[2/7] installing Node.js 22…"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# ── pnpm ─────────────────────────────────────────────────────────────────────
echo "[3/7] installing pnpm…"
npm install -g pnpm

# ── PM2 ──────────────────────────────────────────────────────────────────────
echo "[4/7] installing PM2…"
npm install -g pm2
pm2 install pm2-logrotate

# ── Redis ─────────────────────────────────────────────────────────────────────
echo "[5/7] installing Redis…"
apt-get install -y redis-server

# Harden Redis: bind to localhost only
sed -i 's/^bind .*/bind 127.0.0.1/' /etc/redis/redis.conf
# Enable LRU eviction policy (required alongside maxmemory to have effect)
sed -i 's/^# maxmemory-policy.*/maxmemory-policy allkeys-lru/' /etc/redis/redis.conf
# Set a memory cap so the eviction policy is actually triggered
sed -i 's/^# maxmemory .*/maxmemory 128mb/' /etc/redis/redis.conf
# If neither line was present (some distros omit them), append both
grep -qF 'maxmemory-policy' /etc/redis/redis.conf || echo 'maxmemory-policy allkeys-lru' >> /etc/redis/redis.conf
grep -qF 'maxmemory 128mb' /etc/redis/redis.conf || echo 'maxmemory 128mb' >> /etc/redis/redis.conf

systemctl enable redis-server
systemctl restart redis-server
echo "      Redis bound to 127.0.0.1, maxmemory=128mb, policy=allkeys-lru ✓"

# ── Firewall ──────────────────────────────────────────────────────────────────
echo "[6/7] configuring UFW firewall…"
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw --force enable
echo "      UFW: allow SSH, deny all other inbound ✓"

# ── PM2 startup ──────────────────────────────────────────────────────────────
echo "[7/7] configuring PM2 startup on reboot…"
pm2 startup systemd -u "$USER" --hp "$HOME"
echo "      PM2 startup configured — run 'pm2 save' after first deploy ✓"

echo ""
echo "════════════════════════════════════════"
echo " Setup complete!"
echo " Next steps:"
echo "   1. Clone your repo to /opt/takerbot"
echo "   2. Copy .env.example → .env and fill in PRIVATE_KEY"
echo "   3. Run: bash deploy/scripts/deploy.sh"
echo "════════════════════════════════════════"
