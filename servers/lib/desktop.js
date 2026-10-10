// Builds the shell scripts that let the vast server see and drive the graphical desktop
// of an instance (screenshots, mouse, keyboard, clipboard, launching apps) over SSH.
// The scripts run as root and use xdotool, xclip and ImageMagick, installing them if missing.

import { shellQuote } from './ssh.js';

export const SCREENSHOT_MAX_WIDTH = 1280;

export const DESKTOP_ACTIONS = [
  'click',
  'double_click',
  'right_click',
  'middle_click',
  'move',
  'drag',
  'scroll',
  'type',
  'paste',
  'key',
  'wait',
  'launch',
];

// Finds the desktop session by looking for a process that has DISPLAY set, preferring one
// owned by a normal user. DESK_PID is that process: `launch` and the Studio MCP bridge reuse
// its environment so programs run inside the desktop session, as its user.
export const FIND_SESSION = String.raw`
DESK_PID=""; ROOT_PID=""; ROOT_DISPLAY=""; ROOT_XAUTH=""
for e in /proc/[0-9]*/environ; do
  d=$(tr '\0' '\n' 2>/dev/null < "$e" | sed -n 's/^DISPLAY=//p' | head -n1)
  [ -n "$d" ] || continue
  if [ -n "$WANT_DISPLAY" ] && [ "$d" != "$WANT_DISPLAY" ]; then continue; fi
  pid=$(echo "$e" | cut -d/ -f3)
  [ "$pid" = "$$" ] && continue
  xa=$(tr '\0' '\n' 2>/dev/null < "$e" | sed -n 's/^XAUTHORITY=//p' | head -n1)
  if [ "$(stat -c %u "/proc/$pid" 2>/dev/null)" != "0" ]; then
    DESK_PID=$pid; DISPLAY=$d; XAUTHORITY=$xa; break
  fi
  if [ -z "$ROOT_PID" ]; then ROOT_PID=$pid; ROOT_DISPLAY=$d; ROOT_XAUTH=$xa; fi
done
if [ -z "$DESK_PID" ] && [ -n "$ROOT_PID" ]; then DESK_PID=$ROOT_PID; DISPLAY=$ROOT_DISPLAY; XAUTHORITY=$ROOT_XAUTH; fi

# Writes the session's environment to a file its user can source, and sets DESK_USER.
desk_envfile() {
  DESK_USER=root
  envf=$(mktemp)
  if [ -n "$DESK_PID" ] && [ -r "/proc/$DESK_PID/environ" ]; then
    DESK_USER=$(stat -c %U "/proc/$DESK_PID")
    tr '\0' '\n' < "/proc/$DESK_PID/environ" | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' | sed "s/'/'\\\\''/g; s/^\([^=]*\)=\(.*\)$/export \1='\2'/" > "$envf"
  elif [ -n "$DISPLAY" ]; then
    echo "export DISPLAY='$DISPLAY'" > "$envf"
  fi
  chown "$DESK_USER" "$envf"; chmod 600 "$envf"
}
`;

const PRELUDE = String.raw`
if [ -z "$DESK_PID" ]; then
  DISPLAY=$WANT_DISPLAY
  if [ -z "$DISPLAY" ]; then
    for s in /tmp/.X11-unix/X*; do [ -e "$s" ] && DISPLAY=":$(basename "$s" | cut -c2-)" && break; done
  fi
fi
if [ -z "$DISPLAY" ]; then
  echo "No graphical desktop found on this instance (no X display is running). Rent it with a desktop template, or start one first." >&2
  exit 3
fi
export DISPLAY
if [ -n "$XAUTHORITY" ]; then export XAUTHORITY; else unset XAUTHORITY; fi

need=""
command -v xdotool >/dev/null 2>&1 || need="$need xdotool"
command -v xclip >/dev/null 2>&1 || need="$need xclip"
command -v import >/dev/null 2>&1 || need="$need imagemagick"
if [ -n "$need" ]; then
  (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $need) >/tmp/desktop-tools-install.log 2>&1 || {
    echo "Could not install$need (see /tmp/desktop-tools-install.log on the instance)." >&2
    exit 3
  }
fi

GEOM=$(xdotool getdisplaygeometry 2>&1) || { echo "Cannot open display $DISPLAY: $GEOM" >&2; exit 3; }
set -- $GEOM
SCREEN_W=$1; SCREEN_H=$2
# Coordinates come in screenshot pixels; scale them to screen pixels.
sx() { awk -v v="$1" -v w="$SCREEN_W" -v m="$MAX_W" 'BEGIN { f = (w > m) ? w / m : 1; printf "%d", v * f + 0.5 }'; }
`;

// Starts a command in the background as the desktop user, with the desktop session's environment.
const LAUNCH = String.raw`
desk_launch() {
  desk_envfile
  runuser -u "$DESK_USER" -- sh -c '. "$1"; rm -f "$1"; cd "$HOME" 2>/dev/null || cd /tmp; nohup sh -c "$2" >>/tmp/desktop-launch-$(id -un).log 2>&1 </dev/null &' _ "$envf" "$1"
  echo "launched as $DESK_USER" >&2
}
`;

const SCREENSHOT = String.raw`
echo "SCREEN $SCREEN_W $SCREEN_H"
if [ "$SCREEN_W" -gt "$MAX_W" ]; then
  import -silent -window root -resize "$MAX_W"x png:- | base64 | tr -d '\n'
else
  import -silent -window root png:- | base64 | tr -d '\n'
fi
echo
`;

const KEYS_RE = /^[A-Za-z0-9_+ -]+$/;
const BUTTONS = { click: 1, double_click: 1, right_click: 3, middle_click: 2 };
const SCROLL_BUTTONS = { up: 4, down: 5, left: 6, right: 7 };

function point(a, xKey = 'x', yKey = 'y') {
  const x = a[xKey];
  const y = a[yKey];
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
    throw new Error(`"${a.action}" needs ${xKey} and ${yKey} (screenshot pixels)`);
  }
  return `$(sx ${Math.round(x)}) $(sx ${Math.round(y)})`;
}

/** Turns one action ({ action, x, y, ... }) into shell lines. */
export function actionToShell(a) {
  switch (a.action) {
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'middle_click': {
      const repeat = a.action === 'double_click' ? '--repeat 2 --delay 120 ' : '';
      const move = a.x == null && a.y == null ? '' : `mousemove ${point(a)} `;
      return `xdotool ${move}click ${repeat}${BUTTONS[a.action]}`;
    }
    case 'move':
      return `xdotool mousemove ${point(a)}`;
    case 'drag':
      return `xdotool mousemove ${point(a)} mousedown 1 sleep 0.2 mousemove ${point(a, 'to_x', 'to_y')} sleep 0.2 mouseup 1`;
    case 'scroll': {
      const button = SCROLL_BUTTONS[a.direction || 'down'];
      if (!button) throw new Error('"scroll" direction must be up, down, left or right');
      const amount = Math.min(50, Math.max(1, Math.round(a.amount ?? 3)));
      const move = a.x == null && a.y == null ? '' : `mousemove ${point(a)} `;
      return `xdotool ${move}click --repeat ${amount} --delay 40 ${button}`;
    }
    case 'type':
      if (typeof a.text !== 'string' || !a.text) throw new Error('"type" needs text');
      return `xdotool type --clearmodifiers --delay 12 -- ${shellQuote(a.text)}`;
    case 'paste':
      if (typeof a.text !== 'string' || !a.text) throw new Error('"paste" needs text');
      return [
        `printf '%s' ${shellQuote(a.text)} | xclip -selection clipboard -i >/dev/null 2>&1`,
        'sleep 0.2',
        'xdotool key --clearmodifiers ctrl+v',
      ].join('\n');
    case 'key': {
      if (typeof a.keys !== 'string' || !KEYS_RE.test(a.keys.trim())) {
        throw new Error('"key" needs keys like "Return", "ctrl+s" or "ctrl+a BackSpace" (xdotool key names, space-separated)');
      }
      return `xdotool key --clearmodifiers -- ${a.keys.trim().split(/\s+/).map(shellQuote).join(' ')}`;
    }
    case 'wait': {
      const seconds = Math.min(60, Math.max(0, Number(a.seconds ?? 1)));
      return `sleep ${seconds}`;
    }
    case 'launch':
      if (typeof a.command !== 'string' || !a.command.trim()) throw new Error('"launch" needs a command');
      return `desk_launch ${shellQuote(a.command)}`;
    default:
      throw new Error(`Unknown action "${a.action}" (use ${DESKTOP_ACTIONS.join(', ')})`);
  }
}

/**
 * Builds the full script: find the display, run the actions, optionally wait and take a screenshot.
 * Its stdout ends with "SCREEN <w> <h>" and the base64 PNG when a screenshot is taken.
 */
export function desktopScript({ actions = [], screenshot = true, waitMs = 0, display, maxWidth = SCREENSHOT_MAX_WIDTH } = {}) {
  if (display != null && !/^[A-Za-z0-9.:_-]*$/.test(display)) throw new Error(`Invalid display "${display}"`);
  const lines = [
    `MAX_W=${Math.max(200, Math.round(maxWidth))}`,
    `WANT_DISPLAY=${shellQuote(display || '')}`,
    FIND_SESSION,
    PRELUDE,
    LAUNCH,
    'set -e',
    ...actions.map(actionToShell),
  ];
  if (screenshot) {
    if (waitMs > 0) lines.push(`sleep ${Math.min(30, waitMs / 1000)}`);
    lines.push(SCREENSHOT);
  }
  return lines.join('\n');
}

/** Splits the script's stdout into the screen size and the PNG (base64), if any. */
export function parseScreenshot(stdout) {
  const m = /SCREEN (\d+) (\d+)\n([A-Za-z0-9+/=]*)/.exec(stdout);
  if (!m) return null;
  const screen = { width: Number(m[1]), height: Number(m[2]) };
  return { screen, png: m[3] || null };
}

/** Size the screenshot is shown at, matching the scaling `sx` applies to coordinates. */
export function shownSize(screen, maxWidth = SCREENSHOT_MAX_WIDTH) {
  if (screen.width <= maxWidth) return { ...screen };
  return { width: maxWidth, height: Math.round((screen.height * maxWidth) / screen.width) };
}

/**
 * Runs `command` in the foreground as the desktop session's user, with its environment
 * (as root when there is no desktop). Its stdin and stdout stay connected, e.g. for an
 * MCP server spoken to over SSH.
 */
export function sessionExecScript(command) {
  return [
    "WANT_DISPLAY=''",
    FIND_SESSION,
    'desk_envfile',
    `exec runuser -u "$DESK_USER" -- sh -c '. "$1"; rm -f "$1"; cd "$HOME" 2>/dev/null || cd /tmp; exec sh -c "$2"' _ "$envf" ${shellQuote(command)}`,
  ].join('\n');
}
