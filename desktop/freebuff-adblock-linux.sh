#!/bin/sh
#
# Freebuff AdBlock for Desktop - Linux
#
# Freebuff Desktop renders ads from the orchestrator process it ships inside its
# own application directory - `resources/orchestrator/orchestrator.js`, run by the
# bundled Bun, not from `app.asar`. A browser extension can never reach it, which
# is why this exists as a separate, local tool. The macOS tool patches the same
# file at the same relative path; the two scripts share their anchors byte for
# byte, and `npm run validate` asserts that.
#
# Linux differs from macOS in one way that shapes everything else: Freebuff ships
# as an AppImage - a single executable holding a read-only SquashFS filesystem.
# There is no install directory and no bundle to edit in place. So this tool never
# writes to the .AppImage, because it cannot: it extracts the image with the
# runtime the image itself carries (`--appimage-extract`, no dependencies, no
# FUSE, no root), keeps the extracted copy under `--work-dir`, patches that, and
# tells you how to run it. The original download is left exactly as it was.
#
# Pointed at an ordinary directory instead - an extracted AppDir, or a system
# install such as `/opt/Freebuff` if Freebuff ever ships one - it patches in place,
# exactly like the macOS tool.
#
# This script disables the ad runtime. It is deliberately boring:
#
#   - It only touches the ad code, at two anchors: the gate the ad auction
#     consults is forced to return "no ads to show", and the ad client's own
#     request helper - the one method every /api/v1/ads/* call goes through - is
#     made to give up before it sends. Nothing else in the file changes.
#   - It refuses to run at all unless every patch anchor is found the exact
#     number of times it expects, and a relaxation is only accepted when ad code
#     sits right beside it. A new Freebuff version that renames a function fails
#     safe and changes nothing, rather than half-patching a 9 MB bundle - and
#     `scan` then shows what that build does contain, so re-anchoring is a
#     report to read instead of a dead end.
#   - It backs up the pristine file before the first write, and `revert` puts it
#     back.
#
# It patches a copy you own, so nothing here needs root. A system-wide install
# under /opt or /usr would, and the tool says so rather than reaching for sudo.
#
# Usage:
#   sh freebuff-adblock-linux.sh            # install (the default)
#   sh freebuff-adblock-linux.sh status     # report what is applied, change nothing
#   sh freebuff-adblock-linux.sh install    # patch, backing up first
#   sh freebuff-adblock-linux.sh verify     # wait for the relaunch, check what it loaded
#   sh freebuff-adblock-linux.sh revert     # restore the pristine backup
#   sh freebuff-adblock-linux.sh doctor     # environment report for a bug report
#   sh freebuff-adblock-linux.sh scan       # show the anchors this build has (for a re-anchor)
#
#   --app PATH          the Freebuff .AppImage to extract, or an AppDir to patch
#                       in place (default: search your home directory and /opt)
#   --work-dir PATH     where the extracted copy is kept
#   --display-only      skip the ad-API anchor (leave the render gate only)
#   --dry-run           with install: report what would happen, write nothing
#   --backup-dir PATH   where the pristine copy lives
#   --no-wait           verify: report now instead of waiting for a relaunch
#   --timeout SECONDS   verify: how long to wait (default 300)
#
# Every Freebuff update ships a new .AppImage, so the patched copy is left behind
# by one. Run `install` again against the new image after an update.
#
# The patch is only half the answer: the orchestrator is read once at launch, so
# a patched file with an old process in memory is a patched file doing nothing.
# `verify` is the other half - it waits for the relaunch and then checks that the
# process running now started after the patch was written. `install` runs it for
# you when Freebuff is open. Both are read-only.
#
# MIT licensed. See LICENSE.

set -u

# Stamped at build time (scripts/build-desktop.mjs).
VERSION="__FBD_VERSION__"
ORIGIN="__FBD_ORIGIN__"

BACKUP_DIR="${FREEBUFF_ADBLOCK_BACKUP_DIR:-$HOME/freebuff-patch-backups}"
# Where an AppImage is extracted to. One directory per Freebuff version, so an
# update adds a copy instead of overwriting the one you are running.
WORK_DIR="${FREEBUFF_ADBLOCK_WORK_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/freebuff-adblock}"
APP="${FREEBUFF_APP:-}"
DEEP=1
DRY=0
# Waiting is the point of `verify`, and it is only ever done when Freebuff is
# open - a closed app has no relaunch to observe, and an unattended install must
# not sit here. The wait is bounded anyway, and Ctrl-C stops it.
WAIT=1
WAIT_SECS=300
COMMAND=""

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"; GREEN="$(printf '\033[32m')"
  RED="$(printf '\033[31m')"; YELLOW="$(printf '\033[33m')"; OFF="$(printf '\033[0m')"
else
  B=""; DIM=""; GREEN=""; RED=""; YELLOW=""; OFF=""
fi

say() { printf '%s\n' "$*"; }
ok() { printf '  %s%s%s %s\n' "$GREEN" "ok" "$OFF" "$*"; }
warn() { printf '  %s%s%s %s\n' "$YELLOW" "!" "$OFF" "$*"; }
bad() { printf '  %s%s%s %s\n' "$RED" "x" "$OFF" "$*"; }
die() { printf '%s%serror:%s %s\n' "$B" "$RED" "$OFF" "$*" >&2; exit 1; }
hr() { printf '%s\n' "${DIM}--------------------------------------------${OFF}"; }

# ------------------------------------------------------------------- arg parse

while [ $# -gt 0 ]; do
  case "$1" in
    install|status|verify|revert|doctor|scan|help|version) COMMAND="$1"; shift ;;
    --app=*) APP="${1#--app=}"; shift ;;
    --backup-dir=*) BACKUP_DIR="${1#--backup-dir=}"; shift ;;
    --work-dir=*) WORK_DIR="${1#--work-dir=}"; shift ;;
    --app) shift; [ $# -gt 0 ] || die "--app needs a path"; APP="$1"; shift ;;
    --backup-dir) shift; [ $# -gt 0 ] || die "--backup-dir needs a path"; BACKUP_DIR="$1"; shift ;;
    --work-dir) shift; [ $# -gt 0 ] || die "--work-dir needs a path"; WORK_DIR="$1"; shift ;;
    --display-only) DEEP=0; shift ;;
    --deep) DEEP=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --no-wait) WAIT=0; shift ;;
    --timeout) shift; [ $# -gt 0 ] || die "--timeout needs a number of seconds"; WAIT_SECS="$1"; shift ;;
    --timeout=*) WAIT_SECS="${1#--timeout=}"; shift ;;
    -h|--help) COMMAND=help; shift ;;
    --version) COMMAND=version; shift ;;
    *) die "unknown argument: $1  (try --help)" ;;
  esac
done

case "$WAIT_SECS" in
  ''|*[!0-9]*) die "--timeout needs a number of seconds, not '$WAIT_SECS'" ;;
esac

[ -n "$COMMAND" ] || COMMAND=install

# --------------------------------------------------------------------- helpers

# ------------------------------------------------------- finding the app
#
# Two shapes mean the same thing on Linux, and the tool has to tell them apart
# before it writes anything:
#
#   tree   a directory holding `resources/orchestrator/orchestrator.js`. That is
#          an AppImage someone already extracted, a system install, or the copy
#          this tool extracted itself. Patchable in place.
#   image  a `*.AppImage`. A single executable wrapping a read-only SquashFS, so
#          there is nothing to patch in it. It gets extracted first, and the
#          image itself is never opened for writing.

is_tree() {
  [ -f "$1/resources/orchestrator/orchestrator.js" ]
}

image_is_elf() {
  # Every AppImage is an ELF executable carrying its own SquashFS runtime.
  # Checked rather than assumed: extracting a file that is not one would fail
  # with a message from the runtime instead of a sentence about what is wrong.
  [ -f "$1" ] || return 1
  [ "$(od -An -tx1 -N4 "$1" 2>/dev/null | tr -d ' \n')" = "7f454c46" ]
}

# The AppImage's own embedded runtime does the extraction: no squashfs-tools, no
# FUSE, no root, nothing to install first. This is the one operation that makes
# the Linux tool possible at all.
extract_image() {
  image="$1"; dest="$2"

  if [ ! -x "$image" ]; then
    # Worth doing rather than just complaining: the file needs the bit to run at
    # all, chmod is exactly what every AppImage guide tells people to run, and
    # this is their own download. It is reported, never silent.
    chmod +x "$image" 2>/dev/null || true
    if [ -x "$image" ]; then
      # stderr, because this function's stdout is the tree path and nothing else.
      printf '%s\n' "  note     set the executable bit on the image (chmod +x)" >&2
    else
      die "$image is not executable, and could not be made executable.
  Run:  chmod +x '$image'"
    fi
  fi

  image_is_elf "$image" || die "$image is not an AppImage (not an ELF executable).
  Pass --app the Freebuff .AppImage, or a directory to patch in place."

  mkdir -p "$dest" || die "cannot create $dest"
  log="$dest/.extract.log"
  if ! ( cd "$dest" && "$image" --appimage-extract ) >"$log" 2>&1; then
    tail -n 5 "$log" 2>/dev/null >&2
    die "could not extract $image - see $log"
  fi
  rm -f "$log"

  [ -d "$dest/squashfs-root" ] || die "$image extracted no squashfs-root directory"
  is_tree "$dest/squashfs-root" || die "this AppImage has no resources/orchestrator/orchestrator.js.
  Either it is not Freebuff, or Freebuff changed where the orchestrator lives."
  printf '%s' "$dest/squashfs-root"
}

# Where this image's extracted copy lives: one directory per version, so a new
# download never overwrites the copy you are running.
work_dir_for_image() {
  printf '%s/freebuff-%s' "$WORK_DIR" "$(image_version "$1")"
}

# The version an image's file name carries, from the leading number after
# `Freebuff-`: `Freebuff-0.0.164-linux-x86_64.AppImage` and a renamed
# `Freebuff-0.0.164.AppImage` both give `0.0.164`. Matching the leading run
# rather than splitting on `-linux` is deliberate - people rename downloads, and
# `unknown` costs a per-version work directory and a backup name.
image_version() {
  # It has to end on a digit: `Freebuff-0.0.164.AppImage` would otherwise yield
  # `0.0.164.`, and a version with a dot in it becomes a directory name with a
  # dot in it - which reads as a typo in every message that prints it.
  v="$(printf '%s' "${1##*/}" | sed -n 's/^[Ff]reebuff-\([0-9][0-9.]*[0-9]\).*/\1/p')"
  [ -n "$v" ] || v=unknown
  printf '%s' "$v"
}

# An extracted AppDir records the version it came from, which is what names the
# backup. A system install may record nothing; `unknown` is honest and the new
# file still gets its own backup name.
tree_version() {
  for f in "$1"/*.desktop; do
    [ -f "$f" ] || continue
    v="$(sed -n 's/^X-AppImage-Version=//p' "$f" 2>/dev/null | head -n 1)"
    if [ -n "$v" ]; then printf '%s' "$v"; return 0; fi
  done
  printf 'unknown'
}

# Every place a Freebuff AppImage is likely to be. `doctor` prints this list, so
# a tool that finds nothing says where it looked instead of just failing.
app_search_paths() {
  printf '%s\n' \
    "$HOME/Applications" "$HOME/Downloads" "$HOME/.local/bin" "$HOME/bin" \
    "$HOME/Desktop" "/opt" "/usr/local/bin" "$PWD"
}

find_image() {
  for dir in $(app_search_paths); do
    [ -d "$dir" ] || continue
    for f in "$dir"/*Freebuff*.AppImage; do
      [ -f "$f" ] || continue
      printf '%s\n' "$f"
      return 0
    done
  done
  return 1
}

# Resolution is two lines - kind, then path - because the caller has to know
# which one it has before it can decide whether writing is even possible:
#
#   tree      a directory to patch in place
#   image     an AppImage to extract first
#
# Line-oriented rather than tab-separated so a path containing any character at
# all still parses.
resolve_app() {
  if [ -n "$APP" ]; then
    if [ -d "$APP" ]; then
      is_tree "$APP" || die "not a Freebuff application directory: $APP
  Expected $APP/resources/orchestrator/orchestrator.js to exist."
      printf 'tree\n%s\n' "$APP"
      return 0
    fi
    if [ -f "$APP" ]; then
      printf 'image\n%s\n' "$APP"
      return 0
    fi
    die "no such file or directory: $APP"
  fi

  # A copy this tool extracted before is the likeliest thing to mean, and it is
  # the one a previous run patched - so it comes first.
  for candidate in "$WORK_DIR"/*/squashfs-root; do
    [ -d "$candidate" ] || continue
    is_tree "$candidate" || continue
    printf 'tree\n%s\n' "$candidate"
    return 0
  done

  found="$(find_image)" || return 1
  printf 'image\n%s\n' "$found"
  return 0
}

# One call at the top of every command: resolve the app, extract it when it is
# an image, and hand back the tree to work on.
#
#   prep persistent   keep the extracted copy under --work-dir (install, revert,
#                     verify: these all have to agree on one tree)
#   prep ephemeral    extract into a temporary directory and remove it on exit
#                     (status, scan: read-only, and nobody asked for 400 MB of
#                     extracted app to be left behind)
#
# Sets APP_KIND (tree|image), APP_PATH (what --app pointed at), APP_TREE (what to
# patch) and APP_VERSION. Dies rather than guessing when nothing is found.
# Read-only commands extract to a temporary directory; everything else keeps the
# copy under --work-dir so install, revert and verify all agree on one tree.
prep() {
  want="${PREP:-persistent}"

  # `die` inside a command substitution only ends the subshell, so a failure is
  # turned into an exit here, where it ends the run. The reason it printed is
  # already on stderr - which is why nothing is added on the --app path.
  if [ -n "$APP" ]; then
    res="$(resolve_app)" || exit 1
  else
    res="$(resolve_app)" || die "Freebuff Desktop was not found.
  Pass --app /path/to/Freebuff-<version>-linux-x86_64.AppImage, or a directory
  holding resources/orchestrator/orchestrator.js.
  Looked in: $(app_search_paths | tr '\n' ' ')"
  fi

  APP_KIND="$(printf '%s\n' "$res" | sed -n 1p)"
  APP_PATH="$(printf '%s\n' "$res" | sed -n 2p)"
  APP_TREE="$APP_PATH"

  if [ "$APP_KIND" = "image" ]; then
    APP_VERSION="$(image_version "$APP_PATH")"
    dest="$(work_dir_for_image "$APP_PATH")"

    # Already extracted - by this tool, from this image. Reuse it rather than
    # extracting again: it is the tree a previous install patched.
    if is_tree "$dest/squashfs-root"; then
      APP_TREE="$dest/squashfs-root"
      # A copy already on disk knows its own version even when the image was
      # renamed, so the report and the backup name stop saying "unknown".
      if [ "$APP_VERSION" = "unknown" ]; then APP_VERSION="$(tree_version "$APP_TREE")"; fi
      return 0
    fi

    if [ "$want" = "ephemeral" ]; then
      TMP_TREE="$(mktemp -d "${TMPDIR:-/tmp}/fbd-image.XXXXXX")" || die "cannot create a temporary directory"
      # Persisted for the life of this process only; the trap is what guarantees
      # the copy does not outlive it.
      trap 'rm -rf "$TMP_TREE"' EXIT INT TERM
      say ""
      say "  extracting $APP_PATH"
      say "  ${DIM}-> a temporary copy, removed when this finishes${OFF}"
      APP_TREE="$(extract_image "$APP_PATH" "$TMP_TREE")" || exit 1
      if [ "$APP_VERSION" = "unknown" ]; then APP_VERSION="$(tree_version "$APP_TREE")"; fi
      return 0
    fi

    say ""
    say "  extracting $APP_PATH"
    say "  ${DIM}-> $dest${OFF}"
    say "  ${DIM}(once per version; later runs reuse this copy)${OFF}"
    APP_TREE="$(extract_image "$APP_PATH" "$dest")" || exit 1
    if [ "$APP_VERSION" = "unknown" ]; then APP_VERSION="$(tree_version "$APP_TREE")"; fi
    return 0
  fi

  APP_VERSION="$(tree_version "$APP_PATH")"
}

# The same header in every report: what was resolved, and what is being read.
show_app() {
  if [ "$APP_KIND" = "image" ]; then
    say "  image    $APP_PATH"
    say "  copy     $APP_TREE"
  else
    say "  app      $APP_TREE"
  fi
  say "  version  $APP_VERSION"
  say "  target   $APP_TREE/resources/orchestrator/orchestrator.js"
}

# Any process actually running an orchestrator out of this tree. `pgrep -f`
# matches any command line that merely mentions the path, so the command line has
# to *end* with it - see orchestrator_pids below.
orchestrator_running() {
  [ -n "$(orchestrator_pids "$1")" ]
}

# Processes running the orchestrator out of an image that is mounted but not
# patched, i.e. the original download. Informational: it is how the tool can say
# "quit that first" without pretending the patch applies to it.
mount_pids() {
  command -v pgrep >/dev/null 2>&1 || return 1
  for pid in $(pgrep -f '/tmp/.mount_.*/resources/orchestrator/orchestrator.js' 2>/dev/null); do
    cmd="$(ps -p "$pid" -o command= 2>/dev/null | sed 's/[[:space:]]*$//')"
    case "$cmd" in */.mount_*/resources/orchestrator/orchestrator.js) printf '%s\n' "$pid" ;; esac
  done
}

#
# The relaunch check.
#
# `status` and `scan` read a file, and a file cannot say whether the app you are
# looking at is running it. The orchestrator is read once at launch, so the one
# honest test is a comparison of two times: when the patch was written, and when
# the process that is running now started. Started later means the patched file
# is what it read. Nothing here writes anything and nothing here leaves the
# machine.

# Every orchestrator process running out of this application directory - the
# extracted copy when the app was an AppImage, or the install directory when it
# is patched in place. The path is the tree's own, so `--app` is matched too.
orchestrator_pids() {
  command -v pgrep >/dev/null 2>&1 || return 1
  want="$1/resources/orchestrator/orchestrator.js"
  for pid in $(pgrep -f "$want" 2>/dev/null); do
    # `pgrep -f` matches any command line that merely *mentions* the path - a
    # `tail -f` on it, an editor, a shell whose arguments name it. Only the
    # process actually running the file ends with it, and only that one is the
    # orchestrator. Without this, a check that happened to name the path would
    # find itself and call the app verified.
    cmd="$(ps -p "$pid" -o command= 2>/dev/null | sed 's/[[:space:]]*$//')"
    case "$cmd" in
      *"$want") printf '%s\n' "$pid" ;;
    esac
  done
}

# When that process started, as an epoch second. Elapsed time is the only thing
# ps gives portably, so the start is now minus it. ps reports it in whole
# seconds, which is a second of slop either way, so the comparison that uses this
# allows for exactly that much and no more - see the pass condition below.
proc_start_epoch() {
  et="$(ps -p "$1" -o etime= 2>/dev/null | tr -d '[:space:]')"
  [ -n "$et" ] || return 1
  days=0
  case "$et" in *-*) days="${et%%-*}"; et="${et#*-}" ;; esac
  h=0; m=0; s=0
  case "$et" in
    *:*:*) h="${et%%:*}"; rest="${et#*:}"; m="${rest%%:*}"; s="${rest#*:}" ;;
    *:*)   m="${et%%:*}"; s="${et#*:}" ;;
    *)     s="$et" ;;
  esac
  case "$days$h$m$s" in *[!0-9]*) return 1 ;; esac
  printf '%s' "$(( $(date +%s) - (days * 86400 + h * 3600 + m * 60 + s) ))"
}

# The readable form of the same thing, for the report only. Never compared.
proc_started_at() {
  ps -p "$1" -o lstart= 2>/dev/null | tr -s ' ' | sed 's/^ //;s/ $//'
}

# The patch time, as an epoch second. BSD stat first (macOS), GNU second, so the
# same helper answers on the machine this patches and in the test sandbox.
file_mtime() {
  m="$(stat -f '%m' "$1" 2>/dev/null)"
  case "$m" in ''|*[!0-9]*) m="$(stat -c '%Y' "$1" 2>/dev/null)" ;; esac
  case "$m" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s' "$m"
}

# "18s after the patch", "4m before the patch" - how the two times differ, in
# words, for the report. Never for the decision.
span_words() {
  secs="$1"; when="after"
  if [ "$secs" -lt 0 ]; then secs=$(( 0 - secs )); when="before"; fi
  if [ "$secs" -lt 90 ]; then printf '%ss %s the patch' "$secs" "$when"
  else printf '%sm %s the patch' "$(( secs / 60 ))" "$when"; fi
}

# The whole line about the two times. A delta inside the last two seconds is
# reported as what it is - as close as the clock here resolves - rather than as
# "1s before the patch", which would read as a contradiction next to a pass.
clock_words() {
  delta="$1"
  if [ "$delta" -lt -2 ]; then
    printf 'that is %s, so it has not been relaunched since' "$(span_words "$delta")"
  elif [ "$delta" -le 1 ]; then
    printf 'that is within a second of the patch, as close as this clock resolves'
  else
    printf 'that is %s' "$(span_words "$delta")"
  fi
}

# The ad runtime this tool patches, as "auction 17 · gravity 4". Empty when none
# of those names appears at all - the one way this build can be said to have no
# ad code left for the patch to block. Read-only.
ad_code_line() {
  engine probes "$1" "$DEEP" 2>/dev/null | awk -F'|' '
    $1 != "PROBE" { next }
    $2 == "auction" || $2 == "displayAd" || $2 == "gravity" ||
    $2 == "sponsor" || $2 == "track/click" {
      if ($3 > 0) { printf "%s%s %s", sep, $2, $3; sep = " · " }
    }'
}

#
# The patch engine.
#
# Perl does the byte-level work: the bundle is one 9 MB line, so the match and
# replace happen in a single pass with the file read whole. The shell passes a
# mode (check|apply) and reads back a report. Every patch is counted before it
# is touched - a mismatch is a refusal, never a guess.
#
engine() {
  mode="$1"; target="$2"; deep="$3"
  prog="$(mktemp "${TMPDIR:-/tmp}/fbd-engine.XXXXXX")" || die "could not create a temp file"
  cat > "$prog" <<'FBD_PERL'
use strict;
use warnings;

my $mode   = shift(@ARGV) // 'check';
my $target = shift(@ARGV) // '';
my $deep   = shift(@ARGV) // '1';
die "no target file\n" unless $target ne '' && -f $target;

# Each patch carries an ordered list of strategies.
#
# The first is the exact literal this tool was verified against. The second is a
# relaxation, so a Freebuff release that renames a function but keeps the shape
# does not brick the tool. A relaxation only counts as a match when it hits the
# expected number of times *and* every hit has ad code beside it, so a decoy
# `if (somethingTest...(process.env))` elsewhere in a 9 MB bundle is never
# mistaken for the ad render path. When nothing matches exactly, the tool still
# refuses - and points at `scan`, which prints what this build actually has.
#
# `layer` separates the render patches from the request choke-points so
# --display-only can drop the latter.
my $AD_NEAR = qr/(?:displayAd|auction|adRequest|adsRequest|gravity|sponsor|track\/click|adServer|adUnit|campaign|\bads?\b)/i;

my @patches = (
  {
    id     => 'render',
    layer  => 'display',
    # 0.0.164 has ONE render gate. 0.0.155 had two (`displayAd` + `auction`), and
    # the displayAd one is gone from the bundle - `scan` shows a single match for
    # both the literal and the relaxation, in auction().
    what   => 'force the ad auction to return no ads',
    expect => 1,
    tries  => [
      {
        name => 'literal',
        find => qr/\Qif (localAgenticTestCampaign(process.env))\E/,
        repl => 'if (true/*FBD-ADS-OFF:render*/)',
      },
      {
        name => 'relaxed',
        find => qr/\bif\s*\(\s*[A-Za-z_\$][\w\$]*Test[A-Za-z_\$]*\s*\(\s*process\.env\s*\)\s*\)/,
        near => $AD_NEAR,
        repl => 'if (true/*FBD-ADS-OFF:render*/)',
      },
    ],
  },
  # There is deliberately no `post` anchor any more, and it must not come back
  # without a reason. The 0.0.155 tool had one, for an ad helper that no longer
  # exists: in 0.0.164 `async post(...)` matches the ad break-event *telemetry*
  # poster and the logs shipper that posts to ${API_HOST}/api/logs. Patching the
  # latter would break Freebuff's own logging and block no ads, and a literal
  # that keeps matching two unrelated helpers is exactly what this tool must not
  # aim at. The `request` anchor below already stops the ad API being reached.
  {
    id     => 'request',
    layer  => 'request',
    what   => 'stop the ad client from reaching the ad API',
    expect => 1,
    tries  => [
      {
        name => 'literal',
        # Re-anchored against 0.0.164, where this is unique. The second argument
        # is matched name-agnostically because it is a minifier-supplied local
        # (`path27` in the build this was verified against) and will be renamed
        # by any future build; the shape around it will not. The other six
        # `async request(` definitions in 0.0.164 belong to a proxy, the sites
        # client and the config clients, and none of them has this signature.
        find => qr/async request\(method, [A-Za-z_\$][\w\$]*, payload, timeoutMs = REQUEST_TIMEOUT_MS\) \{/,
        repl => 'async request(method, path, payload, timeoutMs = REQUEST_TIMEOUT_MS) { return { ok: !1, status: 0, message: "" }; /*FBD-ADS-OFF:request*/',
      },
      {
        name => 'relaxed',
        find => qr/(?<![.\w\$])(?:(?:async|static)\s+)*request\s*\([^)]*\)\s*\{/,
        near => $AD_NEAR,
        repl => 'async request(method, path, payload, timeoutMs = REQUEST_TIMEOUT_MS) { return { ok: !1, status: 0, message: "" }; /*FBD-ADS-OFF:request*/',
      },
    ],
  },
);

# ------------------------------------------------------------------ matching

# Every position a pattern matches, as [offset, length].
sub find_hits {
  my ($src, $find) = @_;
  my @hits;
  while ($src =~ /$find/g) {
    push @hits, [ $-[0], $+[0] - $-[0] ];
  }
  return @hits;
}

# A probe is a substring a person greps for by hand, matched case-insensitively:
# a case-sensitive `agenticTestCampaign` misses `localAgenticTestCampaign`, which
# reads as "the ad runtime is gone" when it is right there.
sub probe_hits {
  my ($src, $probe) = @_;
  return find_hits($src, qr/\Q$probe\E/i);
}

# A relaxation has to be corroborated: ad code within 320 bytes of the hit.
# Literals have no `near` and are trusted as they always were.
sub near_ok {
  my ($src, $hit, $near) = @_;
  return 1 unless defined $near;
  my $from = $hit->[0] - 320;
  $from = 0 if $from < 0;
  return substr($src, $from, $hit->[1] + 640) =~ $near ? 1 : 0;
}

sub window {
  my ($src, $hit, $span) = @_;
  $span = 140 unless defined $span;
  my $from = $hit->[0] - $span;
  $from = 0 if $from < 0;
  my $chunk = substr($src, $from, $hit->[1] + 2 * $span);
  $chunk =~ s/\s+/ /g;
  $chunk =~ s/^ //;
  $chunk =~ s/ $//;
  return $chunk;
}

# The first strategy this source can be patched with, the counts seen, and how
# many hits were ad-adjacent.
sub evaluate {
  my ($src, $p) = @_;
  my @notes;
  my $hits = 0;

  for my $t (@{ $p->{tries} }) {
    my @h = find_hits($src, $t->{find});
    next unless @h;
    my $n    = scalar @h;
    my $near = scalar grep { near_ok($src, $_, $t->{near}) } @h;
    $hits = $n if $n > $hits;
    # A strategy with no `near` is trusted as written, so an adjacency count for
    # it would be vacuous - "6 beside ad code" implies a corroboration that
    # never ran. Say which it is.
    push @notes,
      defined $t->{near}
      ? sprintf('%s: %d match(es), %d beside ad code', $t->{name}, $n, $near)
      : sprintf('%s: %d match(es), trusted as written', $t->{name}, $n);
    next unless $n == $p->{expect} && $near == $n;
    # The first usable strategy wins, and the rest are not even run: on a 9 MB
    # file the literal is the common case, and scanning it once beats scanning
    # every relaxation looking for a better answer that does not exist.
    return ($t, \@notes, $hits);
  }

  return (undef, \@notes, $hits);
}

# --------------------------------------------------------------- scan report

my @PROBES = (
  'displayAd', 'auction', 'agenticTestCampaign', 'testCampaign', 'process.env',
  'async post(', 'async request(', 'gravity', 'sponsor', 'track/click', 'NODE_ENV',
);

# A read-only description of what this build actually contains. This is the
# payload for a re-anchor: if a Freebuff update moves an anchor, `scan` shows
# every candidate site and its surroundings, and nothing is written.
sub run_scan {
  my ($src, $target, $deep) = @_;
  my @o;

  push @o, '== environment ==';
  push @o, "  target   $target";
  push @o, '  bytes    ' . length($src);
  push @o, "  perl     $]";
  push @o, '';

  for my $p (@patches) {
    my $skip   = ($p->{layer} eq 'request' && $deep ne '1') ? 1 : 0;
    my $marker = "FBD-ADS-OFF:$p->{id}";
    my $n      = () = $src =~ /\Q$marker\E/g;

    push @o, sprintf('== %s == %d needed, %d marker(s) already in place', $p->{id}, $p->{expect}, $n);
    push @o, "   $p->{what}";

    if ($skip) {
      push @o, '   skipped: --display-only';
      push @o, '';
      next;
    }

    for my $t (@{ $p->{tries} }) {
      my @h    = find_hits($src, $t->{find});
      my $c    = scalar @h;
      my $near = scalar grep { near_ok($src, $_, $t->{near}) } @h;
      my $uses = ($c == $p->{expect} && $near == $c) ? '   <- usable' : '';

      push @o,
        sprintf(
          defined $t->{near}
          ? '   %-8s %d match(es), %d beside ad code%s'
          : '   %-8s %d match(es), trusted as written%s',
          $t->{name}, $c, (defined $t->{near} ? $near : ()), $uses);

      my $shown = 0;
      for my $h (@h) {
        last if $shown >= 3;
        $shown++;
        push @o, "     [$shown] " . window($src, $h);
      }
    }

    push @o, '';
  }

  push @o, '== probes == (case-insensitive)';
  for my $probe (@PROBES) {
    my @h = probe_hits($src, $probe);
    push @o, sprintf('   %-20s %d', $probe, scalar @h);
    my $shown = 0;
    for my $h (@h) {
      last if $shown >= 2;
      $shown++;
      push @o, "     [$shown] " . window($src, $h, 90);
    }
  }

  return join("\n", @o) . "\n";
}

open(my $in, '<', $target) or die "cannot read $target: $!\n";
binmode $in;
local $/;
my $src = <$in>;
close $in;

if ($mode eq 'scan') {
  print run_scan($src, $target, $deep);
  exit 0;
}

# The same probe counts without the prose. `scan` and the relaunch check both
# want them; only one of those is for a person to read.
if ($mode eq 'probes') {
  for my $probe (@PROBES) {
    my @h = probe_hits($src, $probe);
    printf "PROBE|%s|%d\n", $probe, scalar @h;
  }
  exit 0;
}

my $original = $src;
my @rows;

for my $p (@patches) {
  my $id     = $p->{id};
  my $marker = "FBD-ADS-OFF:$id";
  my $skip   = ($p->{layer} eq 'request' && $deep ne '1') ? 1 : 0;

  my $markers = () = $src =~ /\Q$marker\E/g;
  my $state;
  my $via     = '-';
  my $anchors = 0;
  my @notes   = ();

  if ($skip) {
    $state = 'skipped';
  } elsif ($markers == $p->{expect}) {
    $state = 'applied';
  } elsif ($markers > 0) {
    $state = 'broken';
  } else {
    my ($usable, $notes_ref, $hits) = evaluate($src, $p);
    @notes = @$notes_ref;

    if ($usable) {
      $via     = $usable->{name};
      $anchors = $p->{expect};
      $state   = 'ready';

      if ($mode eq 'apply') {
        my $find = $usable->{find};
        my $repl = $usable->{repl};
        my $n = ($src =~ s/$find/$repl/g);
        if ($n == $p->{expect}) {
          $state   = 'applied';
          $markers = $p->{expect};
          $anchors = 0;
        } else {
          $state = 'failed';
        }
      }
    } else {
      # Nothing usable. A hit count that is merely wrong is ambiguous (the
      # shape is there, the count is not); no hits at all is unknown.
      $state   = $hits ? 'ambiguous' : 'unknown';
      $anchors = scalar find_hits($src, $p->{tries}[0]{find});
    }
  }

  push @rows, {
    id => $id, what => $p->{what}, state => $state, via => $via,
    anchors => $anchors, markers => $markers, expect => $p->{expect},
    # Why it is not ok, carried out to the shell so a refusal can explain
    # itself: "render ambiguous" alone is not a report anyone can act on.
    notes => join('; ', @notes),
  };
}

my $failed = scalar grep { $_->{state} =~ /^(broken|unknown|ambiguous|failed)$/ } @rows;
my $changed = ($src ne $original) ? 1 : 0;

if ($mode eq 'apply' && $changed && !$failed) {
  my @st = stat($target);
  my $perm = $st[2] & 07777;
  my $tmp = "$target.fbd-new";
  open(my $out, '>', $tmp) or die "cannot write $tmp: $!\n";
  binmode $out;
  print $out $src;
  close $out;
  chmod $perm, $tmp;
  rename($tmp, $target) or die "cannot replace $target: $!\n";
}

for my $r (@rows) {
  printf "PATCH|%s|%s|%d|%d|%d|%s|%s|%s\n",
    $r->{id}, $r->{state}, $r->{anchors}, $r->{markers}, $r->{expect},
    $r->{via}, $r->{what}, $r->{notes};
}
printf "WRITTEN|%d\n", ($mode eq 'apply' && $changed && !$failed) ? 1 : 0;
print $failed ? "RESULT|fail\n" : "RESULT|ok\n";
exit($failed ? 3 : 0);
FBD_PERL
  perl "$prog" "$mode" "$target" "$deep"
  code=$?
  rm -f "$prog"
  return $code
}

verdict_of() {
  printf '%s\n' "$1" | sed -n 's/^RESULT|//p' | tail -n 1
}

render_report() {
  printf '%s\n' "$1" | while IFS='|' read -r kind id state anchors markers expect via what notes; do
    [ "$kind" = "PATCH" ] || continue
    case "$state" in
      applied)   mark="${GREEN}applied${OFF}" ;;
      ready)     mark="${YELLOW}ready${OFF}" ;;
      skipped)   mark="${DIM}skipped${OFF}" ;;
      failed)    mark="${RED}failed${OFF}" ;;
      broken)    mark="${RED}broken${OFF}" ;;
      ambiguous) mark="${RED}ambiguous${OFF}" ;;
      unknown)   mark="${RED}not found${OFF}" ;;
      *)         mark="${RED}${state}${OFF}" ;;
    esac
    if [ "$via" = "relaxed" ]; then
      mark="$mark ${DIM}(via relaxed match)${OFF}"
    fi
    printf '  %-9s %s\n' "$id" "$mark"

    # The counts, when the anchor is not simply applied. This is the line that
    # turns "ambiguous" into something a reader can act on without running scan.
    case "$state" in
      ambiguous|unknown|broken|failed)
        [ -n "${notes:-}" ] && printf '            %s%s%s\n' "$DIM" "$notes" "$OFF"
        ;;
    esac
  done
}

all_applied() {
  # $1 report. True when nothing is left to do and nothing is wrong.
  [ "$(verdict_of "$1")" = "ok" ] || return 1
  printf '%s\n' "$1" | awk -F'|' '$1=="PATCH" && $3=="ready" { n++ } END { exit (n>0) }'
}

writable() {
  probe="$1.fbd-probe"
  if ( : > "$probe" ) 2>/dev/null; then rm -f "$probe"; return 0; fi
  return 1
}

permission_help() {
  hr
  say "${B}That directory is not writable by you.${OFF}"
  say ""
  say "  If Freebuff is installed system-wide (under /opt or /usr), the whole"
  say "  install belongs to root and only root can patch it. Two ways forward:"
  say ""
  say "    ${B}1.${OFF} Extract the AppImage instead - the recommended path. Point"
  say "       --app at the .AppImage you downloaded and everything happens in"
  say "       ${WORK_DIR}, which you own. No password, nothing system-wide touched."
  say ""
  say "    ${B}2.${OFF} Re-run this exact command with ${B}sudo${OFF} if you really mean to"
  say "       patch the system copy. This tool never escalates by itself and"
  say "       never asks for a password."
  hr
}

# ------------------------------------------------------------------ commands

cmd_version() {
  say "freebuff-adblock-desktop-linux $VERSION"
  say "$ORIGIN"
}

cmd_help() {
  say "${B}Freebuff AdBlock for Desktop (Linux)${OFF} $VERSION"
  say "Blocks the ads Freebuff Desktop renders from its bundled orchestrator."
  say ""
  say "${B}usage${OFF}"
  say "  sh freebuff-adblock-linux.sh [command] [options]"
  say ""
  say "${B}commands${OFF}"
  say "  install   patch the app (default; backs up first)"
  say "  status    report what is applied - changes nothing"
  say "  verify    wait for Freebuff to be relaunched, then check what it loaded"
  say "  scan      show every anchor this build has - changes nothing"
  say "  revert    restore the pristine backup"
  say "  doctor    environment report"
  say "  version   print the tool version"
  say ""
  say "${B}options${OFF}"
  say "  --app PATH         the Freebuff .AppImage, or a directory to patch in place"
  say "  --work-dir PATH    where the extracted copy is kept"
  say "  --display-only     skip the ad-API anchor (leave the render gate only)"
  say "  --dry-run          report only, write nothing"
  say "  --backup-dir PATH  where the pristine copy lives"
  say "  --no-wait          verify: report now instead of waiting for the relaunch"
  say "  --timeout SECONDS  how long verify waits (default 300)"
  say ""
  say "${B}The AppImage rule.${OFF} Freebuff ships as one executable holding a"
  say "read-only filesystem, so there is no file inside it to patch and this tool"
  say "never writes to your download. It extracts the image with the runtime the"
  say "image carries, patches that copy under ${B}$WORK_DIR${OFF}, and tells you how"
  say "to run it. Point --app at an ordinary directory instead - an AppDir you"
  say "extracted, or a system install - and it patches in place."
  say ""
  say "A patch on disk is not the same as a patch in effect: the orchestrator is"
  say "read once at launch. ${B}verify${OFF} waits for the relaunch and reports the"
  say "two times that decide it - when the patch was written and when the process"
  say "running now started. Ctrl-C stops the wait; nothing it does writes to the app."
  say ""
  say "After any Freebuff update, run ${B}install${OFF} again against the new image -"
  say "an update is a new AppImage, and the patched copy is left behind by it."
  say ""
  say "Each anchor has a literal form and a relaxed one. The relaxed form is only"
  say "used when it is found the expected number of times ${B}and${OFF} ad code sits"
  say "beside it, and a write is undone if the check afterwards disagrees. If a"
  say "patch reports ${B}not found${OFF}, ${B}scan${OFF} lists what this build does have."
}

cmd_status() {
  PREP=ephemeral
  prep
  target="$APP_TREE/resources/orchestrator/orchestrator.js"
  version="$APP_VERSION"
  say "${B}Freebuff Ad Block${OFF} - desktop tool $VERSION"
  show_app
  say ""

  report="$(engine check "$target" "$DEEP")"
  render_report "$report"

  if [ "$(verdict_of "$report")" = "ok" ]; then
    if all_applied "$report"; then
      say ""
      say "  ${GREEN}Ads are off.${OFF} Quit Freebuff and reopen it, then check what it loaded:"
      say "    sh freebuff-adblock-linux.sh verify"
    else
      say ""
      say "  ${YELLOW}Not patched yet.${OFF} Run: sh freebuff-adblock-linux.sh install"
    fi
    return 0
  fi

  say ""
  bad "This orchestrator.js does not match what the tool expects."
  say "  Either it was already modified by another tool, or this Freebuff version"
  say "  changed the file. Nothing was written."
  say ""
  say "  See what this build actually has:  sh freebuff-adblock-linux.sh scan"
  say ""
  if [ -f "$BACKUP_DIR/orchestrator.js.$version.orig" ]; then
    say "  A pristine backup exists. Restore it, then install again:"
    say "    sh freebuff-adblock-linux.sh revert && sh freebuff-adblock-linux.sh install"
  else
    say "  If you patched this by hand before, restore the original file first."
  fi
  return 1
}

cmd_install() {
  prep
  target="$APP_TREE/resources/orchestrator/orchestrator.js"
  version="$APP_VERSION"

  say "${B}Freebuff Ad Block${OFF} - desktop tool $VERSION"
  show_app
  say ""

  report="$(engine check "$target" "$DEEP")" || true

  if [ "$(verdict_of "$report")" != "ok" ]; then
    render_report "$report"
    say ""
    bad "Refusing to patch - the file does not match this tool's expectations."
    say "  Nothing was written. Either it was modified by another tool, or this"
    say "  Freebuff version changed the ad code."
    say ""
    say "  See what this build actually has:"
    say "    sh freebuff-adblock-linux.sh scan                        (a local copy)"
    say "    curl -fsSL $ORIGIN/downloads/freebuff-adblock-desktop-linux.sh | sh -s scan"
    say "  Read-only either way. The piped one is for when you ran this through"
    say "  curl and have no local copy of the script to point at."
    say ""
    if [ -f "$BACKUP_DIR/orchestrator.js.$version.orig" ]; then
      say "  A pristine backup is on disk:"
      say "    sh freebuff-adblock-linux.sh revert && sh freebuff-adblock-linux.sh install"
      say "    curl -fsSL $ORIGIN/downloads/freebuff-adblock-desktop-linux.sh | sh -s revert"
    fi
    return 1
  fi

  if all_applied "$report"; then
    say "  ${GREEN}Already patched.${OFF} Nothing to do."
    say "  Quit Freebuff and reopen it if ads are still showing."
    return 0
  fi

  say "  Would patch:"
  render_report "$report"
  say ""

  if [ "$DRY" = "1" ]; then
    say "  ${DIM}--dry-run: nothing was written.${OFF}"
    return 0
  fi

  if ! writable "$target"; then
    permission_help
    return 1
  fi

  command -v perl >/dev/null 2>&1 || die "perl is required but was not found (it ships with macOS)"
  mkdir -p "$BACKUP_DIR"
  backup="$BACKUP_DIR/orchestrator.js.$version.orig"
  if [ -f "$backup" ]; then
    say "  backup   ${DIM}kept${OFF} $backup"
  else
    if ! cp "$target" "$backup" 2>/dev/null; then
      permission_help
      return 1
    fi
    say "  backup   $backup"
  fi

  say ""
  engine apply "$target" "$DEEP" >/dev/null || {
    bad "the patch did not apply cleanly - the file was left untouched"
    return 1
  }

  after="$(engine check "$target" "$DEEP")" || true

  # A relaxed anchor is an inference, not a literal this tool was verified
  # against, so the write only stands if a fresh count agrees with it. If it
  # does not, the pristine copy goes straight back - a half-patched bundle is
  # the one outcome worth undoing.
  if [ "$(verdict_of "$after")" != "ok" ] || ! all_applied "$after"; then
    render_report "$after"
    say ""
    bad "the patch did not verify after writing - putting the original back"
    if cp "$backup" "$target" 2>/dev/null; then
      ok "restored $target"
    else
      bad "could not restore $target - copy it back by hand: $backup"
    fi
    return 1
  fi

  render_report "$after"
  say ""

  # No re-sign step, and none is needed: an AppImage's signature, where it has
  # one, is an embedded `.sha256`/GPG signature over the whole image. This tool
  # never writes to the image, and the extracted copy beside it is plain files.
  ok "patched Freebuff $version"
  hr
  if [ "$APP_KIND" = "image" ]; then
    # Nothing to wait for here. The patched copy is not the file the user
    # double-clicked, and no relaunch of the original can ever load it - so this
    # is the one honest ending: say exactly what to start instead.
    say "${B}Start the patched copy, not the original image:${OFF}"
    say "  '$APP_TREE/AppRun'"
    say ""
    say "  ${B}$APP_PATH${OFF} was not modified at all. Keep it as your fallback:"
    say "  it is the unpatched app, and running it still shows ads."
    if [ -n "$(mount_pids)" ]; then
      say ""
      warn "Freebuff is running from the image right now - quit that first, or you"
      say "             will have two copies of it open."
    fi
    say ""
    say "  Then check what it loaded:  sh freebuff-adblock-linux.sh verify"
  elif orchestrator_running "$APP_TREE"; then
    say "${B}Freebuff is running. Quit it completely and start it again.${OFF}"
    say "The orchestrator is read once at launch, so the patch only takes effect"
    say "on the next start - focusing the window is not enough."
    say ""
    # Only when there is a relaunch to wait for. A closed app has nothing to
    # observe, and an unattended install must not sit here for five minutes.
    if [ "$WAIT" = "1" ]; then
      verify_running "$APP_TREE" "$target" || true
    else
      say "  Then check what it loaded:  sh freebuff-adblock-linux.sh verify"
    fi
  else
    say "${B}Start Freebuff.${OFF} The patch takes effect on the next start."
    say "  Then check what it loaded:  sh freebuff-adblock-linux.sh verify"
  fi
  say ""
  say "Undo any time:  sh freebuff-adblock-linux.sh revert"
  say "After a Freebuff update, re-run:  sh freebuff-adblock-linux.sh install"
}

cmd_revert() {
  prep
  target="$APP_TREE/resources/orchestrator/orchestrator.js"
  version="$APP_VERSION"
  backup="$BACKUP_DIR/orchestrator.js.$version.orig"

  if [ ! -f "$backup" ]; then
    say "No backup for $version in $BACKUP_DIR"
    if [ -d "$BACKUP_DIR" ]; then
      say "Available backups:"
      for f in "$BACKUP_DIR"/orchestrator.js.*.orig; do
        [ -f "$f" ] && say "  $f"
      done
    fi
    die "nothing to restore"
  fi

  if ! writable "$target"; then
    permission_help
    return 1
  fi

  if ! cp "$backup" "$target" 2>/dev/null; then
    permission_help
    return 1
  fi

  ok "restored $target from $backup"
  say "  Start Freebuff again to bring the ads back."
}

cmd_doctor() {
  distro="unknown"
  if [ -r /etc/os-release ]; then
    distro="$(sed -n 's/^PRETTY_NAME="\{0,1\}\(.*\)"\{0,1\}$/\1/p' /etc/os-release 2>/dev/null | head -n 1)"
    [ -n "$distro" ] || distro=unknown
  fi

  say "${B}freebuff-adblock-desktop-linux $VERSION${OFF}"
  say "  origin        $ORIGIN"
  say "  os            $(uname -s) $(uname -r)"
  say "  distro        $distro"
  say "  shell         ${SHELL:-unknown}"
  say "  perl          $(command -v perl || echo 'MISSING')"
  say "  pgrep / ps    $(command -v pgrep >/dev/null 2>&1 && echo pgrep || echo 'pgrep MISSING') / $(command -v ps >/dev/null 2>&1 && echo ps || echo 'ps MISSING')"
  say "  work dir      $WORK_DIR"
  say "  backup dir    $BACKUP_DIR"
  say ""

  kind=""; path=""; tree=""; dest=""
  if res="$(resolve_app)"; then
    kind="$(printf '%s\n' "$res" | sed -n 1p)"
    path="$(printf '%s\n' "$res" | sed -n 2p)"
  fi

  if [ -z "$kind" ]; then
    bad "no Freebuff AppImage or AppDir was found"
    say "  looked in     $(app_search_paths | tr '\n' ' ')"
    say "  Pass --app if it lives somewhere else."
  elif [ "$kind" = "image" ]; then
    say "  image         $path"
    say "  image version $(image_version "$path")"
    dest="$(work_dir_for_image "$path")"
    if is_tree "$dest/squashfs-root"; then
      tree="$dest/squashfs-root"
      say "  extracted     $tree"
      say "  copy version  $(tree_version "$tree")"
    else
      say "  extracted     (nothing yet - install extracts it)"
      say "  would use     $dest/squashfs-root"
    fi
  else
    tree="$path"
    say "  app           $path"
    say "  app version   $(tree_version "$path")"
    say "  ${DIM}(an AppDir or an install directory - patched in place)${OFF}"
  fi
  say ""

  if [ -n "$tree" ]; then
    target="$tree/resources/orchestrator/orchestrator.js"
    say "  orchestrator  $target"
    if [ -f "$target" ]; then
      say "  size          $(wc -c < "$target" | tr -d ' ') bytes"
      if writable "$target"; then
        ok "this copy is writable"
      else
        bad "this copy is NOT writable (a system install needs sudo, or use the AppImage)"
      fi
      report="$(engine check "$target" "$DEEP")" || true
      render_report "$report"
    else
      bad "orchestrator.js is missing from that directory"
    fi
  fi
  say ""

  mounted="$(mount_pids)"
  if [ -n "$mounted" ]; then
    warn "Freebuff is running from an AppImage mount (pid $(printf '%s' "$mounted" | tr '\n' ' '))"
  elif [ -n "$tree" ] && orchestrator_running "$tree"; then
    warn "Freebuff is running from this copy"
  else
    ok "nothing is running from a copy this tool knows about"
  fi
}

# Read-only. Prints every candidate site this build contains, so a Freebuff
# release that moved an anchor is a report to read rather than a dead end.
# Nothing inside the bundle is opened for writing.
cmd_scan() {
  PREP=ephemeral
  prep
  target="$APP_TREE/resources/orchestrator/orchestrator.js"
  version="$APP_VERSION"

  say "${B}Freebuff Ad Block${OFF} - anchor scan (tool $VERSION)"
  show_app
  say ""

  report="$(engine scan "$target" "$DEEP")" || die "the scan could not read $target"

  printf '%s\n' "$report"
  say ""

  out="$BACKUP_DIR/orchestrator-scan.$version.txt"
  if mkdir -p "$BACKUP_DIR" 2>/dev/null && printf '%s\n' "$report" > "$out" 2>/dev/null; then
    ok "saved    $out"
    say "  Nothing inside the app was touched. When a patch reports"
    say "  ${B}not found${OFF}, this file is what re-anchoring the tool needs."
  else
    warn "could not write $out - copy the block above instead"
  fi
}

# What no file can answer: whether the app you are looking at loaded the patched
# file. The orchestrator is read once at launch, so a process that started after
# the patch was written is reading it - and that is the whole test. Waiting is
# the price, because the answer only becomes true after a relaunch.
cmd_verify() {
  prep
  target="$APP_TREE/resources/orchestrator/orchestrator.js"
  version="$APP_VERSION"
  say "${B}Freebuff Ad Block${OFF} - desktop tool $VERSION"
  show_app
  say ""

  report="$(engine check "$target" "$DEEP")" || true

  if [ "$(verdict_of "$report")" != "ok" ]; then
    render_report "$report"
    say ""
    bad "This orchestrator.js does not match what the tool expects."
    say "  There is nothing of this tool's to verify, and nothing was written."
    say ""
    say "  See what this build actually has:  sh freebuff-adblock-linux.sh scan"
    return 1
  fi

  if ! all_applied "$report"; then
    render_report "$report"
    say ""
    say "  ${YELLOW}Not patched yet.${OFF} Run: sh freebuff-adblock-linux.sh install"
    return 1
  fi

  render_report "$report"
  say ""
  # A relaunch means something different on the two paths. Patching in place
  # means the app the user already has will read the new file when it starts
  # again. An extracted copy is a second app, so the wait can only be satisfied
  # by starting that one - and the report has to name it.
  if [ "$APP_KIND" = "image" ]; then LAUNCH_CMD="$APP_TREE/AppRun"; else LAUNCH_CMD=""; fi
  verify_running "$APP_TREE" "$target"
}

# The two times, and the wait between them. Returns 0 only when the process
# running now started after the patch was written.
verify_running() {
  app="$1"; target="$2"
  mtime="$(file_mtime "$target")" || mtime=""
  remaining="$WAIT_SECS"
  announced=0
  waiting=0
  interrupted=0
  trap 'interrupted=1' INT

  while :; do
    pid=""; started=""
    for candidate in $(orchestrator_pids "$app"); do
      s="$(proc_start_epoch "$candidate")" || continue
      if [ -z "$started" ] || [ "$s" -gt "$started" ]; then pid="$candidate"; started="$s"; fi
    done

    # Two seconds of tolerance, and both seconds are the clock's fault: ps
    # reports a process's age in whole seconds, so one started immediately after
    # the write can read as a second before it. No real relaunch is ever that
    # close to the patch, and a false "relaunch and run this again" is worse than
    # a false pass in a window two seconds wide.
    if [ -n "$pid" ] && [ -n "$mtime" ] && [ "$started" -ge "$(( mtime - 2 ))" ]; then
      say "  running    pid $pid, started $(proc_started_at "$pid")"
      say "             $(clock_words "$(( started - mtime ))")"
      ad="$(ad_code_line "$target")"
      if [ -n "$ad" ]; then
        say "  ad code    still in this build: $ad"
      else
        warn "the ad runtime this patch aims at is not in this build"
        say "             Freebuff may have removed it, or moved it. scan lists"
        say "             every site this build does have."
      fi
      say ""
      ok "the running app is the patched file"
      say "  The ad auction in it returns no ads, and the ad client gives up before"
      say "  it sends. What no check here can see is whether an ad break still"
      say "  appears - only you can. On the free tier, run a turn: an ad card is"
      say "  the one carrying an \"AD\" chip or a /track/click link."
      trap - INT
      return 0
    fi

    # Why not, said once, so a long wait does not repeat itself.
    if [ "$announced" = "0" ]; then
      if [ -z "$pid" ]; then
        if [ -n "${LAUNCH_CMD:-}" ]; then
          say "  running    nothing is running from the patched copy"
          say "             start it with:  $LAUNCH_CMD"
        else
          say "  running    Freebuff is not open."
        fi
      elif [ -z "$mtime" ]; then
        say "  running    pid $pid, started $(proc_started_at "$pid")"
        say "             the patch time could not be read, so the two cannot be compared"
      else
        say "  running    pid $pid, started $(proc_started_at "$pid")"
        say "             $(clock_words "$(( started - mtime ))")"
      fi
      announced=1
    fi

    if [ "$WAIT" = "0" ]; then
      say ""
      say "  ${YELLOW}Not verified.${OFF} This check needs something running the patched"
      say "  file. Quit Freebuff completely, start it again, then run this again:"
      if [ -n "${LAUNCH_CMD:-}" ]; then say "    '$LAUNCH_CMD'"; fi
      say "    sh freebuff-adblock-linux.sh verify"
      trap - INT
      return 1
    fi

    if [ "$waiting" = "0" ]; then
      say ""
      if [ -n "${LAUNCH_CMD:-}" ]; then
        say "  Waiting for '$LAUNCH_CMD' to be started…  ${DIM}(Ctrl-C to stop)${OFF}"
      else
        say "  Waiting for Freebuff to be quit and started again…  ${DIM}(Ctrl-C to stop)${OFF}"
      fi
      waiting=1
    fi

    if [ "$interrupted" = "1" ] || [ "$remaining" -le 0 ]; then
      say ""
      say "  ${YELLOW}Stopped waiting.${OFF} The patch itself is fine - this check only"
      say "  needs the relaunch. Run it again once Freebuff is running:"
      if [ -n "${LAUNCH_CMD:-}" ]; then say "    '$LAUNCH_CMD'"; fi
      say "    sh freebuff-adblock-linux.sh verify"
      trap - INT
      return 1
    fi

    sleep 2
    remaining=$(( remaining - 2 ))
  done
}

# ------------------------------------------------------------------------ run

case "$COMMAND" in
  install) cmd_install ;;
  status)  cmd_status ;;
  verify)  cmd_verify ;;
  revert)  cmd_revert ;;
  doctor)  cmd_doctor ;;
  scan)    cmd_scan ;;
  version) cmd_version ;;
  help)    cmd_help ;;
  *)       die "unknown command: $COMMAND" ;;
esac
