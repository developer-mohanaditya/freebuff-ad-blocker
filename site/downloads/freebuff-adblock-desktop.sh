#!/bin/sh
#
# Freebuff AdBlock for Desktop
#
# Freebuff Desktop renders ads from the orchestrator process it ships inside its
# own .app bundle - `Contents/Resources/orchestrator/orchestrator.js`, run by the
# bundled Bun, not from `app.asar`. A browser extension can never reach it, which
# is why this exists as a separate, local tool.
#
# This script disables the ad runtime in place. It is deliberately boring:
#
#   - It only touches the ad code. The two render entry points are forced to
#     return "nothing to show", and the two request helpers that talk to the ad
#     API are made to give up before they send. Nothing else in the file changes.
#   - It refuses to run at all unless every patch anchor is found the exact
#     number of times it expects. A new Freebuff version that renames a function
#     fails safe and changes nothing, rather than half-patching a 9 MB bundle.
#   - It backs up the pristine file before the first write, and `revert` puts it
#     back.
#
# It writes into an app bundle, so macOS App Management has to let your terminal
# do that. If it is blocked, the tool says exactly what to switch on instead of
# failing halfway through a write.
#
# Usage:
#   sh freebuff-adblock.sh            # install (the default)
#   sh freebuff-adblock.sh status     # report what is applied, change nothing
#   sh freebuff-adblock.sh install    # patch, backing up first
#   sh freebuff-adblock.sh revert     # restore the pristine backup
#   sh freebuff-adblock.sh doctor     # environment report for a bug report
#
#   --app PATH          the Freebuff.app to patch (default: /Applications)
#   --display-only      skip the request choke-points (render paths only)
#   --dry-run           with install: report what would happen, write nothing
#   --backup-dir PATH   where the pristine copy lives
#   --resign            ad-hoc re-sign the bundle after patching
#
# Every Freebuff update replaces Contents/Resources, so the patch is gone after
# one. Run `install` again after an update.
#
# MIT licensed. See LICENSE.

set -u

# Stamped at build time (scripts/build-desktop.mjs).
VERSION="1.3.0"
ORIGIN="https://freebuff-adblocker.vercel.app"

BACKUP_DIR="${FREEBUFF_ADBLOCK_BACKUP_DIR:-$HOME/freebuff-patch-backups}"
APP="${FREEBUFF_APP:-}"
DEEP=1
DRY=0
RESIGN=0
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
    install|status|revert|doctor|help|version) COMMAND="$1"; shift ;;
    --app=*) APP="${1#--app=}"; shift ;;
    --backup-dir=*) BACKUP_DIR="${1#--backup-dir=}"; shift ;;
    --app) shift; [ $# -gt 0 ] || die "--app needs a path"; APP="$1"; shift ;;
    --backup-dir) shift; [ $# -gt 0 ] || die "--backup-dir needs a path"; BACKUP_DIR="$1"; shift ;;
    --display-only) DEEP=0; shift ;;
    --deep) DEEP=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --resign) RESIGN=1; shift ;;
    -h|--help) COMMAND=help; shift ;;
    --version) COMMAND=version; shift ;;
    *) die "unknown argument: $1  (try --help)" ;;
  esac
done

[ -n "$COMMAND" ] || COMMAND=install

# --------------------------------------------------------------------- helpers

find_app() {
  if [ -n "$APP" ]; then
    [ -d "$APP/Contents/Resources/orchestrator" ] || die "not a Freebuff app bundle: $APP"
    printf '%s\n' "$APP"
    return 0
  fi
  for candidate in "/Applications/Freebuff.app" "$HOME/Applications/Freebuff.app"; do
    if [ -d "$candidate/Contents/Resources/orchestrator" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

app_version() {
  plist="$1/Contents/Info.plist"
  if [ -x /usr/libexec/PlistBuddy ] && [ -f "$plist" ]; then
    v="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist" 2>/dev/null || true)"
    if [ -n "$v" ]; then printf '%s' "$v"; return 0; fi
  fi
  if [ "$(uname -s)" = "Darwin" ] && [ -f "$plist" ]; then
    v="$(defaults read "$plist" CFBundleShortVersionString 2>/dev/null || true)"
    if [ -n "$v" ]; then printf '%s' "$v"; return 0; fi
  fi
  printf 'unknown'
}

app_running() {
  command -v pgrep >/dev/null 2>&1 || return 1
  pgrep -x Freebuff >/dev/null 2>&1
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

# Each patch names the exact text to look for, how many times it must appear,
# and the replacement. `layer` separates the render patches from the request
# choke-points so --display-only can drop the latter.
my @patches = (
  {
    id     => 'render',
    layer  => 'display',
    what   => 'stop the ad render paths (displayAd + auction)',
    expect => 2,
    find   => qr/\Qif (localAgenticTestCampaign(process.env))\E/,
    repl   => 'if (true/*FBD-ADS-OFF:render*/)',
  },
  {
    id     => 'post',
    layer  => 'request',
    what   => 'stop the ad request helper from sending',
    expect => 1,
    find   => qr/async post\([^)]*\) \{/,
    repl   => 'async post(path, body, options = {}) { return { ok: false, status: 0, json: async () => ({}) }; /*FBD-ADS-OFF:post*/',
  },
  {
    id     => 'request',
    layer  => 'request',
    what   => 'stop the ad request helper from sending',
    expect => 1,
    find   => qr/async request\([^)]*\) \{/,
    repl   => 'async request(method, path, payload, timeoutMs = REQUEST_TIMEOUT_MS) { return { ok: !1, status: 0, message: "" }; /*FBD-ADS-OFF:request*/',
  },
);

open(my $in, '<', $target) or die "cannot read $target: $!\n";
binmode $in;
local $/;
my $src = <$in>;
close $in;

my $original = $src;
my @rows;

for my $p (@patches) {
  my $id     = $p->{id};
  my $marker = "FBD-ADS-OFF:$id";
  my $skip   = ($p->{layer} eq 'request' && $deep ne '1') ? 1 : 0;

  my $markers = () = $src =~ /\Q$marker\E/g;
  my $anchors = () = $src =~ /$p->{find}/g;

  my $state;
  if ($skip)                        { $state = 'skipped'; }
  elsif ($markers == $p->{expect})  { $state = 'applied'; }
  elsif ($markers > 0)              { $state = 'broken'; }
  elsif ($anchors == $p->{expect})  { $state = 'ready'; }
  elsif ($anchors == 0)             { $state = 'unknown'; }
  else                              { $state = 'ambiguous'; }

  if ($mode eq 'apply' && $state eq 'ready') {
    my $find = $p->{find};
    my $repl = $p->{repl};
    my $n = ($src =~ s/$find/$repl/g);
    if ($n == $p->{expect}) {
      $state  = 'applied';
      $markers = $p->{expect};
      $anchors = 0;
    } else {
      $state = 'failed';
    }
  }

  push @rows, {
    id => $id, what => $p->{what}, state => $state,
    anchors => $anchors, markers => $markers, expect => $p->{expect},
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
  printf "PATCH|%s|%s|%d|%d|%d|%s\n",
    $r->{id}, $r->{state}, $r->{anchors}, $r->{markers}, $r->{expect}, $r->{what};
}
printf "WRITTEN|%d\n", ($mode eq 'apply' && $changed && !$failed) ? 1 : 0;
print $failed ? "RESULT|fail\n" : "RESULT|ok\n";
exit $failed ? 3 : 0;
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
  printf '%s\n' "$1" | while IFS='|' read -r kind id state anchors markers expect what; do
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
    printf '  %-9s %s\n' "$id" "$mark"
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
  say "${B}macOS is blocking writes into the app bundle.${OFF}"
  say ""
  say "  System Settings -> Privacy & Security -> App Management"
  say "  switch ON the app you are running this from (Terminal, iTerm, VS Code…),"
  say "  then ${B}quit and reopen that app${OFF} and run this again."
  say ""
  say "  This is macOS's own guard on app bundles. The tool never asks for a"
  say "  password and never uses sudo."
  hr
}

# ------------------------------------------------------------------ commands

cmd_version() {
  say "freebuff-adblock-desktop $VERSION"
  say "$ORIGIN"
}

cmd_help() {
  say "${B}Freebuff AdBlock for Desktop${OFF} $VERSION"
  say "Blocks the ads Freebuff Desktop renders from its bundled orchestrator."
  say ""
  say "${B}usage${OFF}"
  say "  sh freebuff-adblock.sh [command] [options]"
  say ""
  say "${B}commands${OFF}"
  say "  install   patch the app (default; backs up first)"
  say "  status    report what is applied - changes nothing"
  say "  revert    restore the pristine backup"
  say "  doctor    environment report"
  say "  version   print the tool version"
  say ""
  say "${B}options${OFF}"
  say "  --app PATH         the Freebuff.app to patch (default: /Applications)"
  say "  --display-only     skip the request choke-points"
  say "  --dry-run          report only, write nothing"
  say "  --backup-dir PATH  where the pristine copy lives"
  say "  --resign           ad-hoc re-sign the bundle after patching"
  say ""
  say "After any Freebuff update, run ${B}install${OFF} again - an update replaces"
  say "the whole Resources folder and the patch goes with it."
}

cmd_status() {
  app="$(find_app)" || die "Freebuff Desktop was not found in /Applications or ~/Applications.
  Pass --app /path/to/Freebuff.app if it lives somewhere else."
  target="$app/Contents/Resources/orchestrator/orchestrator.js"
  [ -f "$target" ] || die "no orchestrator.js in $app - is that the Freebuff app?"

  version="$(app_version "$app")"
  say "${B}Freebuff Ad Block${OFF} - desktop tool $VERSION"
  say "  app      $app"
  say "  version  $version"
  say "  target   $target"
  say ""

  report="$(engine check "$target" "$DEEP")"
  render_report "$report"

  if [ "$(verdict_of "$report")" = "ok" ]; then
    if all_applied "$report"; then
      say ""
      say "  ${GREEN}Ads are off.${OFF} Quit Freebuff and reopen it if you have not already."
    else
      say ""
      say "  ${YELLOW}Not patched yet.${OFF} Run: sh freebuff-adblock.sh install"
    fi
    return 0
  fi

  say ""
  bad "This orchestrator.js does not match what the tool expects."
  say "  Either it was already modified by another tool, or this Freebuff version"
  say "  changed the file. Nothing was written."
  say ""
  if [ -f "$BACKUP_DIR/orchestrator.js.$version.orig" ]; then
    say "  A pristine backup exists. Restore it, then install again:"
    say "    sh freebuff-adblock.sh revert && sh freebuff-adblock.sh install"
  else
    say "  If you patched this by hand before, restore the original file first."
  fi
  return 1
}

cmd_install() {
  app="$(find_app)" || die "Freebuff Desktop was not found in /Applications or ~/Applications.
  Pass --app /path/to/Freebuff.app if it lives somewhere else."
  target="$app/Contents/Resources/orchestrator/orchestrator.js"
  [ -f "$target" ] || die "no orchestrator.js in $app - is that the Freebuff app?"

  version="$(app_version "$app")"

  say "${B}Freebuff Ad Block${OFF} - desktop tool $VERSION"
  say "  app      $app"
  say "  version  $version"
  say ""

  report="$(engine check "$target" "$DEEP")" || true

  if [ "$(verdict_of "$report")" != "ok" ]; then
    render_report "$report"
    say ""
    bad "Refusing to patch - the file does not match this tool's expectations."
    say "  Nothing was written. Either it was modified by another tool, or this"
    say "  Freebuff version changed the ad code."
    say ""
    if [ -f "$BACKUP_DIR/orchestrator.js.$version.orig" ]; then
      say "  A pristine backup is on disk:"
      say "    sh freebuff-adblock.sh revert && sh freebuff-adblock.sh install"
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
  render_report "$after"
  say ""

  if [ "$RESIGN" = "1" ] && command -v codesign >/dev/null 2>&1; then
    if codesign --force --deep --sign - "$app" 2>/dev/null; then
      ok "re-signed the bundle ad-hoc"
    else
      warn "re-sign failed - Freebuff may refuse to launch; run: codesign --force --deep --sign - '$app'"
    fi
  fi

  ok "patched Freebuff $version"
  hr
  if app_running; then
    say "${B}Freebuff is running. Quit it completely (Cmd-Q) and reopen it.${OFF}"
    say "The orchestrator is read once at launch, so the patch only takes effect"
    say "on the next start - focusing the window is not enough."
  else
    say "${B}Open Freebuff.${OFF} The patch takes effect on the next launch."
  fi
  say ""
  say "Undo any time:  sh freebuff-adblock.sh revert"
  say "After a Freebuff update, re-run:  sh freebuff-adblock.sh install"
}

cmd_revert() {
  app="$(find_app)" || die "Freebuff Desktop was not found. Pass --app /path/to/Freebuff.app"
  target="$app/Contents/Resources/orchestrator/orchestrator.js"
  version="$(app_version "$app")"
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
  say "  Quit Freebuff and reopen it to bring the ads back."
}

cmd_doctor() {
  say "${B}freebuff-adblock-desktop $VERSION${OFF}"
  say "  origin        $ORIGIN"
  say "  os            $(uname -s) $(uname -r)"
  say "  shell         ${SHELL:-unknown}"
  say "  perl          $(command -v perl || echo 'MISSING')"
  say "  codesign      $(command -v codesign || echo '(none)')"
  say "  backup dir    $BACKUP_DIR"

  if app="$(find_app)"; then
    target="$app/Contents/Resources/orchestrator/orchestrator.js"
    say "  app           $app"
    say "  version       $(app_version "$app")"
    say "  orchestrator  $target"
    if [ -f "$target" ]; then
      say "  size          $(wc -c < "$target" | tr -d ' ') bytes"
      writable "$target" && ok "bundle is writable" || bad "bundle is NOT writable (App Management)"
      report="$(engine check "$target" "$DEEP")" || true
      render_report "$report"
    else
      bad "orchestrator.js is missing"
    fi
  else
    bad "Freebuff Desktop was not found"
  fi

  if app_running; then warn "Freebuff is running"; else ok "Freebuff is not running"; fi
}

# ------------------------------------------------------------------------ run

case "$COMMAND" in
  install) cmd_install ;;
  status)  cmd_status ;;
  revert)  cmd_revert ;;
  doctor)  cmd_doctor ;;
  version) cmd_version ;;
  help)    cmd_help ;;
  *)       die "unknown command: $COMMAND" ;;
esac
