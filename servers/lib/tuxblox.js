// Installs TuxBlox (Roblox Studio on Linux) on an instance from a GitHub repository's
// releases, and talks to Roblox's Studio MCP server through TuxBlox's studio-mcp gateway.

import { FIND_SESSION } from './desktop.js';
import { shellQuote } from './ssh.js';

export const DEFAULT_TUXBLOX_REPO = '4drvndrvndrvn/tuxblox';
export const TUXBLOX_DIR = 'TuxBlox';
// The gateway in a TuxBlox install: Roblox's Studio MCP server over stdio.
export const DEFAULT_STUDIO_MCP_COMMAND = `"$HOME/${TUXBLOX_DIR}/studio-mcp"`;

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TAG_RE = /^[A-Za-z0-9_.+-]+$/;

/**
 * Script (run as root) that downloads the release's *linux-x86_64.tar.zst bundle, extracts it to
 * ~/TuxBlox of the desktop user (or `user`), and reports whether the host can run it.
 * Extracting over an existing install keeps Roblox, its prefix and the launcher's settings.
 */
export function tuxbloxInstallScript({ repo = DEFAULT_TUXBLOX_REPO, tag, user, apiBase = 'https://api.github.com' } = {}) {
  if (!REPO_RE.test(repo)) throw new Error(`Invalid repository "${repo}" (use owner/name)`);
  if (tag && !TAG_RE.test(tag)) throw new Error(`Invalid tag "${tag}"`);
  if (user && !/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new Error(`Invalid username "${user}"`);
  const release = `${apiBase.replace(/\/+$/, '')}/repos/${repo}/releases/${tag ? `tags/${tag}` : 'latest'}`;
  return [
    'set -e',
    "WANT_DISPLAY=''",
    FIND_SESSION,
    `REPO=${shellQuote(repo)}`,
    `RELEASE_API=${shellQuote(release)}`,
    `U=${shellQuote(user || '')}`,
    String.raw`
if [ -z "$U" ]; then
  U=user
  if [ -n "$DESK_PID" ]; then U=$(stat -c %U "/proc/$DESK_PID"); fi
  # TuxBlox refuses to run as root.
  [ "$U" = root ] && U=user
fi
id -u "$U" >/dev/null 2>&1 || useradd -m -s /bin/bash "$U"
HOME_DIR=$(getent passwd "$U" | cut -d: -f6)
[ -d "$HOME_DIR" ] || { mkdir -p "$HOME_DIR"; chown "$U:" "$HOME_DIR"; }

need=""
for b in curl zstd tar; do command -v "$b" >/dev/null 2>&1 || need="$need $b"; done
if [ -n "$need" ]; then
  echo "Installing$need"
  (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ca-certificates $need) >/tmp/tuxblox-deps.log 2>&1 || {
    echo "Could not install$need (see /tmp/tuxblox-deps.log)" >&2; exit 4; }
fi

JSON=$(curl -fsSL -H 'Accept: application/vnd.github+json' "$RELEASE_API") || {
  echo "No release found at $RELEASE_API. Has the repository's Build workflow published one yet?" >&2; exit 4; }
TAG=$(printf '%s' "$JSON" | grep -o '"tag_name": *"[^"]*"' | head -n1 | sed 's/.*"\([^"]*\)"$/\1/')
URL=$(printf '%s' "$JSON" | grep -o '"browser_download_url": *"[^"]*linux-x86_64\.tar\.zst"' | head -n1 | sed 's/.*"\(http[^"]*\)"$/\1/')
[ -n "$URL" ] || { echo "Release $TAG of $REPO has no *linux-x86_64.tar.zst file." >&2; exit 4; }

echo "Downloading TuxBlox $TAG from $URL"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fL --retry 3 -sS -o "$TMP/tuxblox.tar.zst" "$URL"
echo "Extracting to $HOME_DIR/` + TUXBLOX_DIR + String.raw`"
zstd -dc "$TMP/tuxblox.tar.zst" | tar -C "$HOME_DIR" -xf -
chown -R "$U:" "$HOME_DIR/` + TUXBLOX_DIR + String.raw`"
printf '%s\n' "$TAG" > "$HOME_DIR/` + TUXBLOX_DIR + String.raw`/.installed-release"
echo "Installed TuxBlox $TAG from $REPO for user $U."
echo "Launcher: $HOME_DIR/` + TUXBLOX_DIR + String.raw`/TuxBloxLauncher"

K=$(uname -r)
if echo "$K" | awk -F'[.-]' '{ exit !($1 > 6 || ($1 == 6 && $2 >= 7)) }'; then
  echo "Kernel $K: OK (6.7+ needed)."
else
  echo "WARNING: kernel $K is older than 6.7, which TuxBlox needs. Studio will not run on this machine; rent another one."
fi
if command -v vulkaninfo >/dev/null 2>&1; then
  if vulkaninfo --summary >/tmp/vulkaninfo.txt 2>&1; then
    echo "Vulkan: $(grep -m1 -E 'deviceName' /tmp/vulkaninfo.txt | sed 's/^ *//')"
  else
    echo "WARNING: vulkaninfo failed: no working Vulkan driver, which TuxBlox needs."
  fi
else
  echo "Vulkan: not checked (vulkaninfo is not installed; apt-get install vulkan-tools to check)."
fi
`,
  ].join('\n');
}
