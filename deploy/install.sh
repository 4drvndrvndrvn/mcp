#!/usr/bin/env bash
# Installs or updates the app on an Ubuntu/Debian VPS: Node.js, a "nanochat" service user,
# the app in /opt/nanochat/app, a systemd service and Caddy for HTTPS.
#
#   sudo bash deploy/install.sh [domain]
#
# Without a domain it uses <your-ip>.sslip.io, which points at this server and gets a real
# HTTPS certificate too. Run it again after `git pull` to update; .env, mcp-servers.json and
# .data/ (the Vast.ai SSH key) are kept.
set -euo pipefail

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
APP=/opt/nanochat/app
SVC_USER=nanochat

[ "$(id -u)" = 0 ] || { echo "Run as root: sudo bash $0 $*" >&2; exit 1; }
command -v apt-get >/dev/null || { echo "This script supports Ubuntu/Debian (apt). See the README for manual steps." >&2; exit 1; }

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "Installing packages"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl gnupg git openssl \
  debian-keyring debian-archive-keyring apt-transport-https >/dev/null

node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$node_major" -lt 22 ]; then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
fi

if ! command -v caddy >/dev/null; then
  say "Installing Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy >/dev/null
fi

DOMAIN=${1:-}
if [ -z "$DOMAIN" ] && [ -f "$APP/.env" ]; then
  DOMAIN=$(sed -n 's/^ALLOWED_HOSTS=\([^,]*\).*/\1/p' "$APP/.env" | head -n1)
fi
if [ -z "$DOMAIN" ]; then
  ip=$(curl -fsS4 https://api.ipify.org || true)
  [ -n "$ip" ] || { echo "Could not find this server's public IP. Pass a domain: sudo bash $0 chat.example.com" >&2; exit 1; }
  DOMAIN="$(echo "$ip" | tr . -).sslip.io"
fi

say "Installing the app to $APP"
id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/nanochat --shell /usr/sbin/nologin "$SVC_USER"
mkdir -p "$APP"
tar -C "$SRC" --exclude=.git --exclude=node_modules --exclude=.env --exclude=.data \
  --exclude=mcp-servers.json --exclude=ssh-hosts.json -cf - . | tar -C "$APP" -xf -
chown -R "$SVC_USER:$SVC_USER" /opt/nanochat
(cd "$APP" && runuser -u "$SVC_USER" -- npm ci --omit=dev --no-audit --no-fund --loglevel=error)

if [ ! -f "$APP/.env" ]; then
  say "Creating $APP/.env"
  NANOGPT_API_KEY=${NANOGPT_API_KEY:-}
  VAST_API_KEY=${VAST_API_KEY:-}
  if [ -t 0 ]; then
    [ -n "$VAST_API_KEY" ] || read -rp "Vast.ai API key (https://cloud.vast.ai/manage-keys/): " VAST_API_KEY
    [ -n "$NANOGPT_API_KEY" ] || read -rp "NanoGPT API key (optional, used by web_search and the web chat; Enter to skip): " NANOGPT_API_KEY
  fi
  (
    umask 077
    cat > "$APP/.env" <<ENV
NANOGPT_API_KEY=$NANOGPT_API_KEY
VAST_API_KEY=$VAST_API_KEY
HOST=127.0.0.1
PORT=3000
ACCESS_TOKEN=$(openssl rand -hex 24)
ALLOWED_HOSTS=$DOMAIN
EXPOSE_MCP_SERVERS=vast,ssh,web
# Safety nets for renting: refuse pricier machines, destroy forgotten ones.
VAST_MAX_PRICE_PER_HOUR=1.00
VAST_AUTO_DESTROY_MINUTES=240
ENV
  )
  chown "$SVC_USER:$SVC_USER" "$APP/.env"
fi

say "Starting the service"
sed "s|/usr/bin/node|$(command -v node)|" "$APP/deploy/nanochat.service" > /etc/systemd/system/nanochat.service
systemctl daemon-reload
systemctl enable nanochat >/dev/null 2>&1
systemctl restart nanochat

say "Configuring Caddy for https://$DOMAIN"
if ! grep -q "^$DOMAIN " /etc/caddy/Caddyfile 2>/dev/null; then
  [ -f /etc/caddy/Caddyfile ] && cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%s)"
  sed "s/^DOMAIN /$DOMAIN /" "$APP/deploy/Caddyfile" > /etc/caddy/Caddyfile
fi
systemctl enable caddy >/dev/null 2>&1
systemctl reload caddy 2>/dev/null || systemctl restart caddy

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
fi

sleep 3
if ! systemctl is-active --quiet nanochat; then
  journalctl -u nanochat -n 30 --no-pager
  echo "The service did not start (log above)." >&2
  exit 1
fi

TOKEN=$(sed -n 's/^ACCESS_TOKEN=//p' "$APP/.env")
say "Done"
cat <<MSG
Claude app / claude.ai (Settings > Connectors > Add custom connector), URL:
  https://$DOMAIN/mcp/$TOKEN

Claude Code:
  claude mcp add --transport http vps https://$DOMAIN/mcp --header "Authorization: Bearer $TOKEN"

Keep that URL secret: it works like a password.
Settings: $APP/.env (then: sudo systemctl restart nanochat)
Logs:     journalctl -u nanochat -f
MSG
grep -q '^VAST_API_KEY=.' "$APP/.env" || echo "NOTE: VAST_API_KEY is empty in $APP/.env. Add it and restart before renting."
