#Requires -Version 5.1
<#
Freebuff AdBlock for Desktop - Windows

Freebuff Desktop renders ads from the orchestrator process it ships inside its own
install folder - `resources\orchestrator\orchestrator.js`, run by the bundled
runtime, not from `app.asar`. A browser extension can never reach it, which is
why this exists as a separate, local tool.

This is the Windows half of the macOS tool in `freebuff-adblock.sh`. The anchors,
the counts, the markers and the safety rules are the same; only the machinery
around them differs (path discovery, process lookup, the write, and the message a
blocked write gets). It disables the ad runtime in place:

  - It only touches the ad code, at two anchors: the gate the ad auction
    consults is forced to return "no ads to show", and the ad client's own
    request helper - the one method every /api/v1/ads/* call goes through - is
    made to give up before it sends. Nothing else in the file changes.
  - It refuses to run at all unless every patch anchor is found the exact
    number of times it expects, and a relaxation is only accepted when ad code
    sits right beside it. A new Freebuff version that renames a function fails
    safe and changes nothing, rather than half-patching a 9 MB bundle - and
    `scan` then shows what that build does contain, so re-anchoring is a
    report to read instead of a dead end.
  - It backs up the pristine file before the first write, and `revert` puts it
    back.
  - It will not rewrite a file it cannot read as UTF-8, and it will not write
    through anchors whose counts do not match.

Usage, from a PowerShell prompt (PowerShell ships with every Windows, so there
is nothing to install first):

  irm __FBD_ORIGIN__/downloads/freebuff-adblock-desktop.ps1 | iex           # install (the default)
  $s = irm __FBD_ORIGIN__/downloads/freebuff-adblock-desktop.ps1
  & ([scriptblock]::Create($s)) status                                      # any other command

  powershell -ExecutionPolicy Bypass -File .\freebuff-adblock.ps1 scan       # a local copy

The piped form never writes the script to disk, so it carries no
mark-of-the-web and the execution policy never applies to it: `iex` runs a
string, not a .ps1 file. Downloading it by hand does attach the mark, which is
why the documented local form passes -ExecutionPolicy Bypass, and why
`Unblock-File .\freebuff-adblock.ps1` works just as well.

Commands:
  install   patch the app (default; backs up first)
  status    report what is applied - changes nothing
  verify    wait for Freebuff to be relaunched, then check what it loaded
  scan      show every anchor this build has - changes nothing
  revert    restore the pristine backup
  doctor    environment report
  version   print the tool version
  help      this text

Options:
  -App PATH          the Freebuff install folder (auto-detected by default)
  -BackupDir PATH    where the pristine copy lives
  -DisplayOnly       skip the ad-API anchor (leave the render gate only)
  -Deep              the opposite of -DisplayOnly, and the default
  -DryRun            with install: report what would happen, write nothing
  -NoWait            verify: report now instead of waiting for a relaunch
  -Timeout SECONDS   verify: how long to wait (default 300)

Every Freebuff update replaces the resources folder, so the patch is gone after
one. Run `install` again after an update.

The patch is only half the answer: the orchestrator is read once at launch, so a
patched file with an old process in memory is a patched file doing nothing.
`verify` is the other half - it waits for the relaunch and then checks that the
process running now started after the patch was written. `install` runs it for
you when Freebuff is open. Both are read-only.

MIT licensed. See LICENSE.
#>

[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [AllowEmptyCollection()]
  [string[]] $Arguments
)

if ($null -eq $Arguments) { $Arguments = @() }

# Stamped at build time (scripts/build-desktop.mjs).
$Version = '__FBD_VERSION__'
$Origin = '__FBD_ORIGIN__'

$Command = ''
$App = ''
if ($env:FREEBUFF_APP) { $App = $env:FREEBUFF_APP }

$BackupDir = Join-Path $HOME 'freebuff-patch-backups'
if ($env:FREEBUFF_ADBLOCK_BACKUP_DIR) { $BackupDir = $env:FREEBUFF_ADBLOCK_BACKUP_DIR }

$Deep = $true
$Dry = $false
$Wait = $true
$WaitSecs = 300

$script:IsWindowsOS = ($env:OS -eq 'Windows_NT')
$script:UseColor = $false
try {
  $script:UseColor = [bool](
    (-not $env:NO_COLOR) -and (-not [Console]::IsOutputRedirected) -and ($Host.Name -eq 'ConsoleHost')
  )
} catch {
  # A host with no console to ask: plain text is always safe.
  $script:UseColor = $false
}

# ------------------------------------------------------------------- helpers

function Say {
  param([string] $Text = '')
  Write-Host $Text
}

# Colour is per-fragment and always goes through here, so redirection or
# NO_COLOR turns every one of them off together - the report has to stay the same
# text for a person and for a test.
function Write-Piece {
  param([string] $Text, [string] $Color = '')
  if ($script:UseColor -and $Color) { Write-Host -NoNewline $Text -ForegroundColor $Color }
  else { Write-Host -NoNewline $Text }
}

function Ok {
  param([string] $Text)
  Write-Host -NoNewline '  '
  Write-Piece 'ok' 'Green'
  Write-Host " $Text"
}

function Warn {
  param([string] $Text)
  Write-Host -NoNewline '  '
  Write-Piece '!' 'Yellow'
  Write-Host " $Text"
}

function Bad {
  param([string] $Text)
  Write-Host -NoNewline '  '
  Write-Piece 'x' 'Red'
  Write-Host " $Text"
}

function Die {
  param([string] $Text)
  [Console]::Error.WriteLine("error: $Text")
  exit 1
}

# ------------------------------------------------------------------ arg parse

$index = 0
while ($index -lt $Arguments.Count) {
  $raw = $Arguments[$index]
  $index++
  if ([string]::IsNullOrWhiteSpace($raw)) { continue }

  $key = $raw
  $inline = $null
  if ($key -match '^--?([^=]+)=(.*)$') {
    $key = $Matches[1]
    $inline = $Matches[2]
  } else {
    $key = $key -replace '^--?', ''
  }
  $key = $key.ToLowerInvariant()

  # The value either came glued on (`-App=C:\x`) or is the next argument.
  $value = $inline
  if ($value -eq $null -and @('app', 'backupdir', 'timeout') -contains $key) {
    if ($index -lt $Arguments.Count) {
      $value = $Arguments[$index]
      $index++
    }
  }

  switch ($key) {
    'install' { $Command = 'install' }
    'status' { $Command = 'status' }
    'verify' { $Command = 'verify' }
    'revert' { $Command = 'revert' }
    'doctor' { $Command = 'doctor' }
    'scan' { $Command = 'scan' }
    'help' { $Command = 'help' }
    'h' { $Command = 'help' }
    'version' { $Command = 'version' }
    'app' {
      if ([string]::IsNullOrWhiteSpace($value)) { Die '-App needs a path' }
      $App = $value
    }
    'backupdir' {
      if ([string]::IsNullOrWhiteSpace($value)) { Die '-BackupDir needs a path' }
      $BackupDir = $value
    }
    'timeout' {
      if ("$value" -notmatch '^\d+$') { Die "-Timeout needs a number of seconds, not '$value'" }
      $WaitSecs = [int]$value
    }
    'displayonly' { $Deep = $false }
    'deep' { $Deep = $true }
    'dryrun' { $Dry = $true }
    'nowait' { $Wait = $false }
    default { Die "unknown argument: $raw  (try help)" }
  }
}

if ([string]::IsNullOrEmpty($Command)) { $Command = 'install' }

# --------------------------------------------------------------- app discovery

function Get-TargetPath {
  param([string] $AppDir)
  return [System.IO.Path]::Combine($AppDir, 'resources', 'orchestrator', 'orchestrator.js')
}

function Get-OrchestratorDir {
  param([string] $AppDir)
  return [System.IO.Path]::Combine($AppDir, 'resources', 'orchestrator')
}

function Test-UnderPath {
  param([string] $Root, [string] $Path)
  if (-not $Root -or -not $Path) { return $false }
  try {
    $separator = [System.IO.Path]::DirectorySeparatorChar
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + $separator
    $pathFull = [System.IO.Path]::GetFullPath($Path)
  } catch {
    return $false
  }
  return $pathFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)
}

<#
Where a Freebuff install can live, in the order the answer is most likely to be
right. Nothing here is a complete inventory - an installer can be pointed at a
custom folder - which is why -App exists and why a miss is reportable rather than
fatal:

  - the uninstall registry entries, the one place a per-user or machine-wide
    install records where it went
  - the running app, which knows its own path
  - the known roots: the per-user installer's Local\Programs\<product> (where
    the Windows build has been seen to install, as @codebufffreebuff-desktop),
    every other folder under Local\Programs so a product rename is still found,
    the Squirrel-style app-<version> folders, and the machine-wide Program Files
    locations
#>
function Get-AppCandidates {
  $list = New-Object System.Collections.Generic.List[string]

  foreach ($hive in @(
      'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
      'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
      'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )) {
    foreach ($entry in @(Get-ItemProperty -Path $hive -ErrorAction SilentlyContinue)) {
      if ("$($entry.DisplayName)" -notmatch 'freebuff') { continue }
      # InstallLocation is a folder; DisplayIcon is the .exe inside it.
      foreach ($field in @("$($entry.InstallLocation)", "$($entry.DisplayIcon)")) {
        if ([string]::IsNullOrWhiteSpace($field)) { continue }
        $candidate = $field.Trim('"').TrimEnd('\', '/')
        if (-not $candidate) { continue }
        $isFile = $false
        try { $isFile = Test-Path -LiteralPath $candidate -PathType Leaf } catch { $isFile = $false }
        if ($isFile) { $candidate = Split-Path -Parent $candidate }
        $list.Add($candidate)
      }
    }
  }

  # The app, if it is running, is the most reliable answer of all.
  foreach ($process in @(Get-Process -Name 'Freebuff*' -ErrorAction SilentlyContinue)) {
    $exe = Get-ProcessPath $process
    if ($exe) { $list.Add((Split-Path -Parent $exe)) }
  }

  $localAppData = $env:LOCALAPPDATA
  if ($localAppData) {
    # The per-user installer's own folder, seen in the wild as
    # %LOCALAPPDATA%\Programs\@codebufffreebuff-desktop
    $list.Add((Join-Path $localAppData 'Programs\@codebufffreebuff-desktop'))
    $list.Add((Join-Path $localAppData 'Programs\Freebuff'))
    $list.Add((Join-Path $localAppData 'Freebuff'))

    $programs = Join-Path $localAppData 'Programs'
    if (Test-Path -LiteralPath $programs -PathType Container) {
      foreach ($dir in @(Get-ChildItem -LiteralPath $programs -Directory -ErrorAction SilentlyContinue)) {
        $list.Add($dir.FullName)
      }
    }

    # Squirrel keeps each build side by side as app-<version>.
    $squirrel = Join-Path $localAppData 'Freebuff'
    if (Test-Path -LiteralPath $squirrel -PathType Container) {
      foreach ($dir in @(Get-ChildItem -LiteralPath $squirrel -Directory -Filter 'app-*' -ErrorAction SilentlyContinue)) {
        $list.Add($dir.FullName)
      }
    }
  }

  if ($env:ProgramFiles) { $list.Add((Join-Path $env:ProgramFiles 'Freebuff')) }
  if (${env:ProgramFiles(x86)}) { $list.Add((Join-Path ${env:ProgramFiles(x86)} 'Freebuff')) }

  $seen = @{}
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($item in $list) {
    if ([string]::IsNullOrWhiteSpace($item)) { continue }
    $dedupe = $item.ToLowerInvariant()
    if ($seen.ContainsKey($dedupe)) { continue }
    $seen[$dedupe] = $true
    $out.Add($item)
  }
  return $out
}

<#
The install folder, or $null. -App may point at the install folder, at its
`resources` folder, or straight at the orchestrator.js - all three name the same
place, and refusing two of them would only be a puzzle for whoever copied a path
out of a bug report.
#>
function Find-AppDir {
  if ($App) {
    $probe = $App
    if (Test-Path -LiteralPath $probe -PathType Leaf) {
      if ((Split-Path -Leaf $probe) -ne 'orchestrator.js') { Die "not a Freebuff install: $probe" }
      $probe = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $probe))
    } elseif ((Split-Path -Leaf $probe) -eq 'resources') {
      $probe = Split-Path -Parent $probe
    }
    if (-not (Test-Path -LiteralPath (Get-OrchestratorDir $probe) -PathType Container)) {
      Die "not a Freebuff install folder: $App`n  Pass -App with the folder that holds resources\orchestrator."
    }
    return $probe
  }

  foreach ($candidate in (Get-AppCandidates)) {
    if (Test-Path -LiteralPath (Get-TargetPath $candidate) -PathType Leaf) { return $candidate }
  }
  return $null
}

<#
The version Freebuff itself reports, never a number this tool invents. Windows has
no Info.plist: the installer writes the version into the executable's own version
resource, and Squirrel puts it in the folder name instead. Whichever is there is
used, and `unknown` is a truthful answer - it only ever names the backup file.
#>
function Get-AppVersion {
  param([string] $AppDir)

  $exe = Join-Path $AppDir 'Freebuff.exe'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    $found = @(Get-ChildItem -LiteralPath $AppDir -Filter '*.exe' -File -ErrorAction SilentlyContinue |
      Sort-Object -Property Name)
    if ($found.Count -gt 0) { $exe = $found[0].FullName } else { $exe = $null }
  }

  if ($exe) {
    try {
      $info = (Get-Item -LiteralPath $exe).VersionInfo
      foreach ($versionText in @("$($info.ProductVersion)", "$($info.FileVersion)")) {
        if ($versionText -match '\d+\.\d+\.\d+') { return $versionText.Trim() }
      }
    } catch {
      # No version resource, or a file that is not a Windows executable.
    }
  }

  $leaf = Split-Path -Leaf $AppDir
  if ($leaf -match '^app-(.+)$') { return $Matches[1] }
  return 'unknown'
}

# ------------------------------------------------------- processes and clocks

function Get-ProcessPath {
  param($Process)
  try { return $Process.Path } catch { return '' }
}

<#
Every process that is plausibly this install's orchestrator, as objects with an id
and a start time.

Two ways in, because the orchestrator is not the only thing the app starts:

  - the app's own process, matched by name and by living inside the install folder
  - anything whose command line *ends* with the orchestrator file - the bundled
    runtime that actually reads it

The second one is matched on the end of the command line on purpose. A window
title, a log path, an editor or a Get-Content on the file all *mention* it; only
the process actually running it ends with it. Without that rule a check that
happened to name the path would find itself and call the app verified.

Both readings are best-effort by nature: Path is empty for a process this user
cannot open, and Win32_Process needs more rights for other users' processes. An
unknown process is treated as absent, never as a pass.
#>
function Get-OrchestratorProcesses {
  param([string] $AppDir, [string] $Target)

  $seen = @{}
  $out = New-Object System.Collections.Generic.List[object]

  $note = {
    param($processId, $start)
    if (-not $processId) { return }
    $key = "$processId"
    if ($seen.ContainsKey($key)) { return }
    $seen[$key] = $true
    $out.Add([pscustomobject]@{ Id = [int]$processId; Start = $start })
  }

  foreach ($process in @(Get-Process -Name 'Freebuff*' -ErrorAction SilentlyContinue)) {
    $exe = Get-ProcessPath $process
    if (-not $exe) { continue }
    if (-not (Test-UnderPath -Root $AppDir -Path $exe)) { continue }
    $start = $null
    try { $start = [DateTimeOffset]$process.StartTime } catch { $start = $null }
    & $note $process.Id $start
  }

  if ($script:IsWindowsOS) {
    foreach ($row in @(Get-CimInstance -ClassName Win32_Process -Filter "Name LIKE 'Freebuff%'" `
          -Property ProcessId, ExecutablePath, CommandLine, CreationDate -ErrorAction SilentlyContinue)) {
      $start = ConvertTo-StartTime $row.CreationDate
      $exe = "$($row.ExecutablePath)"
      if ($exe -and (Test-UnderPath -Root $AppDir -Path $exe)) {
        & $note $row.ProcessId $start
        continue
      }
      $commandLine = "$($row.CommandLine)"
      if (-not $commandLine) { continue }
      $tail = $commandLine.TrimEnd('"').TrimEnd()
      if ($tail.Length -lt $Target.Length) { continue }
      if ($tail.Substring($tail.Length - $Target.Length) -eq $Target) {
        & $note $row.ProcessId $start
      }
    }
  }

  return $out
}

function ConvertTo-StartTime {
  param($Value)
  if (-not $Value) { return $null }
  try {
    if ($Value -is [datetime]) { return [DateTimeOffset]$Value }
    Add-Type -AssemblyName System.Management -ErrorAction SilentlyContinue
    return [DateTimeOffset][System.Management.ManagementDateTimeConverter]::ToDateTime("$Value")
  } catch {
    return $null
  }
}

function Get-PatchTime {
  param([string] $Target)
  try { return [DateTimeOffset](Get-Item -LiteralPath $Target).LastWriteTime } catch { return $null }
}

function Get-SpanWords {
  param([int] $Seconds)
  $secs = $Seconds
  $when = 'after'
  if ($secs -lt 0) {
    $secs = 0 - $secs
    $when = 'before'
  }
  if ($secs -lt 90) { return "${secs}s $when the patch" }
  return ('{0}m {1} the patch' -f [int]($secs / 60), $when)
}

<#
The whole line about the two times. A delta inside the last two seconds is
reported as what it is - as close as the clock here resolves - rather than as
"1s before the patch", which would read as a contradiction next to a pass.
#>
function Get-ClockWords {
  param([int] $Delta)
  if ($Delta -lt -2) { return "that is $(Get-SpanWords $Delta), so it has not been relaunched since" }
  if ($Delta -le 1) { return 'that is within a second of the patch, as close as this clock resolves' }
  return "that is $(Get-SpanWords $Delta)"
}

function Get-FriendlyTime {
  param($When)
  if (-not $When) { return 'unknown' }
  return $When.ToString('yyyy-MM-dd HH:mm:ss', [System.Globalization.CultureInfo]::InvariantCulture)
}

# -------------------------------------------------------------- patch engine

# Ad code, for the corroboration a relaxation needs. Case-insensitive, like the
# macOS tool: on a minified bundle the casing of a name is not something to bet on.
$AdNear = [regex]::new(
  '(?:displayAd|auction|adRequest|adsRequest|gravity|sponsor|track/click|adServer|adUnit|campaign|\bads?\b)',
  [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
)

<#
The patch table - the same two anchors as the macOS tool, the same counts, and the
same replacements, so one `scan` report re-anchors both.

Each patch carries an ordered list of strategies. The first is the exact literal
this tool was verified against. The second is a relaxation, so a Freebuff release
that renames a function but keeps the shape does not brick the tool. A relaxation
only counts as a match when it hits the expected number of times *and* every hit
has ad code beside it, so a decoy `if (somethingTest(process.env))` elsewhere in a
9 MB bundle is never mistaken for the ad render path. When nothing matches
exactly, the tool still refuses - and points at `scan`, which prints what this
build actually has.

There is deliberately no `post` anchor, and it must not come back without a
reason. In 0.0.164 `async post(` matches the ad break-event *telemetry* poster and
the logs shipper that posts to /api/logs. Patching the latter would break
Freebuff's own logging and block no ads, and a literal that keeps matching two
unrelated helpers is exactly what this tool must not aim at. The `request` anchor
already stops the ad API being reached.
#>
$Patches = @(
  @{
    Id     = 'render'
    Layer  = 'display'
    What   = 'force the ad auction to return no ads'
    Expect = 1
    Tries  = @(
      @{
        Name = 'literal'
        Find = [regex]::new([regex]::Escape('if (localAgenticTestCampaign(process.env))'))
        Near = $null
        Repl = 'if (true/*FBD-ADS-OFF:render*/)'
      },
      @{
        Name = 'relaxed'
        Find = [regex]::new('\bif\s*\(\s*[A-Za-z_$][\w$]*Test[A-Za-z_$]*\s*\(\s*process\.env\s*\)\s*\)')
        Near = $AdNear
        Repl = 'if (true/*FBD-ADS-OFF:render*/)'
      }
    )
  },
  @{
    Id     = 'request'
    Layer  = 'request'
    What   = 'stop the ad client from reaching the ad API'
    Expect = 1
    Tries  = @(
      @{
        Name = 'literal'
        # Re-anchored against 0.0.164, where this is unique. The second argument
        # is matched name-agnostically because it is a minifier-supplied local
        # (`path27` in the build this was verified against) and will be renamed by
        # any future build; the shape around it will not. The other six
        # `async request(` definitions in 0.0.164 belong to a proxy, the sites
        # client and the config clients, and none of them has this signature.
        Find = [regex]::new('async request\(method, [A-Za-z_$][\w$]*, payload, timeoutMs = REQUEST_TIMEOUT_MS\) \{')
        Near = $null
        Repl = 'async request(method, path, payload, timeoutMs = REQUEST_TIMEOUT_MS) { return { ok: !1, status: 0, message: "" }; /*FBD-ADS-OFF:request*/'
      },
      @{
        Name = 'relaxed'
        Find = [regex]::new('(?<![.\w$])(?:(?:async|static)\s+)*request\s*\([^)]*\)\s*\{')
        Near = $AdNear
        Repl = 'async request(method, path, payload, timeoutMs = REQUEST_TIMEOUT_MS) { return { ok: !1, status: 0, message: "" }; /*FBD-ADS-OFF:request*/'
      }
    )
  }
)

# A probe is a substring a person greps for by hand, matched case-insensitively: a
# case-sensitive `agenticTestCampaign` misses `localAgenticTestCampaign`, which
# reads as "the ad runtime is gone" when it is right there.
$Probes = @(
  'displayAd', 'auction', 'agenticTestCampaign', 'testCampaign', 'process.env',
  'async post(', 'async request(', 'gravity', 'sponsor', 'track/click', 'NODE_ENV'
)

function Get-LiteralCount {
  param([string] $Source, [string] $Needle)
  if ([string]::IsNullOrEmpty($Needle)) { return 0 }
  $count = 0
  $at = 0
  while (($at = $Source.IndexOf($Needle, $at, [StringComparison]::Ordinal)) -ge 0) {
    $count++
    $at += $Needle.Length
  }
  return $count
}

<#
A relaxation has to be corroborated: ad code within 320 characters of the hit. The
window is measured in characters here where the macOS tool measured bytes - a
9 MB JavaScript bundle is ASCII in practice, and the window is a heuristic either
way. Literals have no `near` and are trusted as they always were.
#>
function Test-Near {
  param([string] $Source, [int] $Index, [int] $Length, [regex] $Near)
  if (-not $Near) { return $true }
  $from = $Index - 320
  if ($from -lt 0) { $from = 0 }
  $span = $Length + 640
  if ($from + $span -gt $Source.Length) { $span = $Source.Length - $from }
  if ($span -le 0) { return $false }
  return $Near.IsMatch($Source.Substring($from, $span))
}

function Get-Window {
  param([string] $Source, [int] $Index, [int] $Length, [int] $Span = 140)
  $from = $Index - $Span
  if ($from -lt 0) { $from = 0 }
  $take = $Length + 2 * $Span
  if ($from + $take -gt $Source.Length) { $take = $Source.Length - $from }
  if ($take -le 0) { return '' }
  return ($Source.Substring($from, $take) -replace '\s+', ' ').Trim()
}

# The first strategy this source can be patched with, the notes the report needs,
# and the largest hit count seen - the counts are what make a refusal readable.
function Get-UsableStrategy {
  param([string] $Source, $Patch)

  $notes = New-Object System.Collections.Generic.List[string]
  $hits = 0

  foreach ($strategy in $Patch.Tries) {
    $matches = $strategy.Find.Matches($Source)
    $count = $matches.Count
    if ($count -eq 0) { continue }

    $near = 0
    if ($strategy.Near) {
      foreach ($match in $matches) {
        if (Test-Near -Source $Source -Index $match.Index -Length $match.Length -Near $strategy.Near) { $near++ }
      }
      $notes.Add(('{0}: {1} match(es), {2} beside ad code' -f $strategy.Name, $count, $near))
    } else {
      # A strategy with no `near` is trusted as written, so an adjacency count for
      # it would be vacuous - "6 beside ad code" would imply a corroboration that
      # never ran. Say which it is.
      $notes.Add(('{0}: {1} match(es), trusted as written' -f $strategy.Name, $count))
    }

    if ($count -gt $hits) { $hits = $count }
    if ($count -ne $Patch.Expect) { continue }
    if ($strategy.Near -and $near -ne $count) { continue }

    # The first usable strategy wins, and the rest are not even run: on a 9 MB file
    # the literal is the common case, and scanning it once beats scanning every
    # relaxation looking for a better answer that does not exist.
    return [pscustomobject]@{ Strategy = $strategy; Notes = $notes; Hits = $hits }
  }

  return [pscustomobject]@{ Strategy = $null; Notes = $notes; Hits = $hits }
}

function Read-Orchestrator {
  param([string] $Target)

  try { $bytes = [System.IO.File]::ReadAllBytes($Target) }
  catch { Die "cannot read ${Target}: $($_.Exception.Message)" }

  # Never rewrite a file in an encoding this tool did not read: a UTF-16 bundle
  # written back as UTF-8 would be a corrupt bundle, and a silently re-encoded one
  # is a worse outcome than a refusal. A file that is not valid UTF-8 is refused
  # for the same reason.
  if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
    Die 'orchestrator.js is UTF-16; this tool only rewrites UTF-8 and will not convert it'
  }

  $hasBom = $false
  $offset = 0
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    $hasBom = $true
    $offset = 3
  }

  $text = $null
  try {
    $encoding = New-Object System.Text.UTF8Encoding($hasBom, $true)
    $text = $encoding.GetString($bytes, $offset, $bytes.Length - $offset)
  } catch {
    Die 'orchestrator.js is not valid UTF-8; this tool will not rewrite it'
  }

  return [pscustomobject]@{ Text = $text; HasBom = $hasBom; Bytes = $bytes.Length }
}

<#
The two ends of the write, kept together.

The new file is built in the target's own folder, so the replacement is a
same-volume operation, and then moved into place with File.Replace, which keeps
the original's ACL and attributes - the things Windows actually enforces. If that
is refused, an in-place copy overwrites the content and the destination keeps the
ACL it had, since the file is not recreated. Neither path touches anything but the
one file, and neither leaves a temporary behind.
#>
function Write-Orchestrator {
  param([string] $Target, [string] $Text, [bool] $HasBom)

  $dir = Split-Path -Parent $Target
  $temp = Join-Path $dir ('.fbd-new-' + [guid]::NewGuid().ToString('N'))
  $encoding = New-Object System.Text.UTF8Encoding($HasBom)

  try {
    [System.IO.File]::WriteAllText($temp, $Text, $encoding)
    try {
      [System.IO.File]::Replace($temp, $Target, $null, $false)
    } catch {
      [System.IO.File]::Copy($temp, $Target, $true)
    }
  } finally {
    if ([System.IO.File]::Exists($temp)) {
      try { [System.IO.File]::Delete($temp) } catch { }
    }
  }
}

# ------------------------------------------------------------ the report rows

function Format-PatchRow {
  param($Row)

  Write-Host -NoNewline ('  {0,-9} ' -f $Row.Id)
  switch ($Row.State) {
    'applied' { Write-Piece 'applied' 'Green' }
    'ready' { Write-Piece 'ready' 'Yellow' }
    'skipped' { Write-Piece 'skipped' 'DarkGray' }
    'failed' { Write-Piece 'failed' 'Red' }
    'broken' { Write-Piece 'broken' 'Red' }
    'ambiguous' { Write-Piece 'ambiguous' 'Red' }
    'unknown' { Write-Piece 'not found' 'Red' }
    default { Write-Piece $Row.State 'Red' }
  }
  if ($Row.Via -eq 'relaxed') {
    Write-Host -NoNewline ' '
    Write-Piece '(via relaxed match)' 'DarkGray'
  }
  Write-Host ''

  # The counts, when the anchor is not simply applied. This is the line that turns
  # "ambiguous" into something a reader can act on without running scan.
  if ((@('ambiguous', 'unknown', 'broken', 'failed') -contains $Row.State) -and $Row.Notes) {
    Write-Host -NoNewline '            '
    Write-Piece $Row.Notes 'DarkGray'
    Write-Host ''
  }
}

function Show-Report {
  param($Result)
  foreach ($row in $Result.Rows) { Format-PatchRow $row }
}

function Test-AllApplied {
  param($Result)
  if ($Result.Verdict -ne 'ok') { return $false }
  foreach ($row in $Result.Rows) {
    if ($row.State -eq 'ready') { return $false }
  }
  return $true
}

function Invoke-Engine {
  param(
    [ValidateSet('check', 'apply')] [string] $Mode,
    [string] $Target,
    [bool] $DeepScan
  )

  $read = Read-Orchestrator -Target $Target
  $source = $read.Text
  $original = $source
  $rows = New-Object System.Collections.Generic.List[object]

  foreach ($patch in $Patches) {
    $markerText = "FBD-ADS-OFF:$($patch.Id)"
    $skip = ($patch.Layer -eq 'request' -and -not $DeepScan)

    $markerCount = Get-LiteralCount -Source $source -Needle $markerText
    $state = ''
    $via = '-'
    $anchors = 0
    $notes = ''

    if ($skip) {
      $state = 'skipped'
    } elseif ($markerCount -eq $patch.Expect) {
      $state = 'applied'
    } elseif ($markerCount -gt 0) {
      $state = 'broken'
    } else {
      $evaluation = Get-UsableStrategy -Source $source -Patch $patch
      $notes = ($evaluation.Notes -join '; ')

      if ($evaluation.Strategy) {
        $via = $evaluation.Strategy.Name
        $anchors = $patch.Expect
        $state = 'ready'

        if ($Mode -eq 'apply') {
          $find = $evaluation.Strategy.Find
          $replacement = $evaluation.Strategy.Repl
          $substitutions = $find.Matches($source).Count
          $source = $find.Replace($source, [System.Text.RegularExpressions.MatchEvaluator] { param($m) $replacement })
          if ($substitutions -eq $patch.Expect) {
            $state = 'applied'
            $markerCount = $patch.Expect
            $anchors = 0
          } else {
            $state = 'failed'
          }
        }
      } else {
        # Nothing usable. A hit count that is merely wrong is ambiguous (the shape
        # is there, the count is not); no hits at all is unknown.
        if ($evaluation.Hits) { $state = 'ambiguous' } else { $state = 'unknown' }
        $anchors = $patch.Tries[0].Find.Matches($source).Count
      }
    }

    $rows.Add([pscustomobject]@{
        Id      = $patch.Id
        What    = $patch.What
        State   = $state
        Via     = $via
        Anchors = $anchors
        Markers = $markerCount
        Expect  = $patch.Expect
        Notes   = $notes
      })
  }

  $failed = 0
  foreach ($row in $rows) {
    if (@('broken', 'unknown', 'ambiguous', 'failed') -contains $row.State) { $failed++ }
  }

  $changed = ($source -ne $original)
  $written = $false
  if ($Mode -eq 'apply' -and $changed -and $failed -eq 0) {
    Write-Orchestrator -Target $Target -Text $source -HasBom $read.HasBom
    $written = $true
  }

  $verdict = 'ok'
  if ($failed) { $verdict = 'fail' }

  return [pscustomobject]@{
    Verdict = $verdict
    Failed  = $failed
    Written = $written
    Rows    = $rows
  }
}

function Get-ProbeCounts {
  param([string] $Source)
  $counts = @{}
  foreach ($probe in $Probes) {
    $counts[$probe] = [regex]::Matches($source, [regex]::Escape($probe), 'IgnoreCase').Count
  }
  return $counts
}

# The ad runtime this tool patches, as "auction 17 · gravity 4". Empty when none of
# those names appears at all - the one way this build can be said to have no ad
# code left for the patch to block. Read-only.
function Get-AdCodeLine {
  param([string] $Target)
  $parts = New-Object System.Collections.Generic.List[string]
  try {
    $source = (Read-Orchestrator -Target $Target).Text
    $counts = Get-ProbeCounts $source
    foreach ($name in @('auction', 'displayAd', 'gravity', 'sponsor', 'track/click')) {
      if ($counts[$name] -gt 0) { $parts.Add("$name $($counts[$name])") }
    }
  } catch {
    return ''
  }
  return ($parts -join ' · ')
}

<#
A read-only description of what this build actually contains. This is the payload
for a re-anchor: if a Freebuff update moves an anchor, `scan` shows every candidate
site and its surroundings, and nothing is written.
#>
function Get-ScanReport {
  param([string] $Target, [string] $AppDir, [bool] $DeepScan)

  $read = Read-Orchestrator -Target $Target
  $source = $read.Text
  $lines = New-Object System.Collections.Generic.List[string]

  $lines.Add('== environment ==')
  $lines.Add("  target   $Target")
  $lines.Add("  install  $AppDir")
  $lines.Add("  bytes    $($read.Bytes)")
  $lines.Add("  utf8-bom $($read.HasBom)")
  $lines.Add("  powershell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition))")
  $lines.Add('')

  foreach ($patch in $Patches) {
    $skip = ($patch.Layer -eq 'request' -and -not $DeepScan)
    $markerText = "FBD-ADS-OFF:$($patch.Id)"
    $markerCount = Get-LiteralCount -Source $source -Needle $markerText

    $lines.Add(('== {0} == {1} needed, {2} marker(s) already in place' -f $patch.Id, $patch.Expect, $markerCount))
    $lines.Add("   $($patch.What)")

    if ($skip) {
      $lines.Add('   skipped: -DisplayOnly')
      $lines.Add('')
      continue
    }

    foreach ($strategy in $patch.Tries) {
      $matches = $strategy.Find.Matches($source)
      $count = $matches.Count
      $near = 0
      if ($strategy.Near) {
        foreach ($match in $matches) {
          if (Test-Near -Source $source -Index $match.Index -Length $match.Length -Near $strategy.Near) { $near++ }
        }
      }

      $usable = ''
      if ($count -eq $patch.Expect -and ((-not $strategy.Near) -or $near -eq $count)) { $usable = '   <- usable' }

      if ($strategy.Near) {
        $lines.Add(('   {0,-8} {1} match(es), {2} beside ad code{3}' -f $strategy.Name, $count, $near, $usable))
      } else {
        $lines.Add(('   {0,-8} {1} match(es), trusted as written{2}' -f $strategy.Name, $count, $usable))
      }

      $shown = 0
      foreach ($match in $matches) {
        if ($shown -ge 3) { break }
        $shown++
        $lines.Add("     [$shown] $(Get-Window -Source $source -Index $match.Index -Length $match.Length)")
      }
    }

    $lines.Add('')
  }

  $lines.Add('== probes == (case-insensitive)')
  $counts = Get-ProbeCounts $source
  foreach ($probe in $Probes) {
    $lines.Add(('   {0,-20} {1}' -f $probe, $counts[$probe]))
    $shown = 0
    foreach ($match in [regex]::Matches($source, [regex]::Escape($probe), 'IgnoreCase')) {
      if ($shown -ge 2) { break }
      $shown++
      $lines.Add("     [$shown] $(Get-Window -Source $source -Index $match.Index -Length $match.Length -Span 90)")
    }
  }

  return (($lines -join [Environment]::NewLine) + [Environment]::NewLine)
}

# --------------------------------------------------------------- write access

<#
Is this file writable? The honest answer needs two things: the file itself, and
the folder it lives in, because replacing a file means creating and renaming
inside that folder. So the probe creates and removes its own temp file in the
folder - it changes nothing else, and a folder where that fails is a folder where
nothing this tool does could have worked.

It is still a probe, not a promise: a permission or a lock can change between here
and the write, which is why every write is wrapped and reports what blocked it.
Nothing is ever half-written: the new content is built elsewhere and moved in.
#>
function Test-CanWrite {
  param([string] $Target)

  $dir = Split-Path -Parent $Target
  $probe = Join-Path $dir ('.fbd-probe-' + [guid]::NewGuid().ToString('N'))
  try {
    $stream = [System.IO.File]::Create($probe)
    $stream.Dispose()
    [System.IO.File]::Delete($probe)
    return $true
  } catch {
    if ([System.IO.File]::Exists($probe)) {
      try { [System.IO.File]::Delete($probe) } catch { }
    }
    return $false
  }
}

<#
What to say when a write is refused, which on Windows is one of three things: the
file is open in the app, the folder needs an elevated shell, or the file carries
the read-only attribute. Naming the wrong one sends someone to the wrong setting,
so the exception is read rather than guessed at.
#>
function Show-WriteHelp {
  param([string] $Target, $ErrorRecord = $null)

  $message = ''
  $sharing = $false
  if ($ErrorRecord) {
    $message = "$($ErrorRecord.Exception.Message)"
    $hresult = 0
    try { $hresult = $ErrorRecord.Exception.HResult } catch { $hresult = 0 }
    # -2147024864 is 0x80070020, ERROR_SHARING_VIOLATION: another handle has the
    # file open with an incompatible sharing mode. On Windows that is usually the
    # app itself, and no amount of elevation would have helped.
    if ($hresult -eq -2147024864 -or $message -match 'being used by another process') { $sharing = $true }
  }

  Write-Host ('-' * 44)
  if ($sharing) {
    Write-Piece 'Freebuff has the file open.' 'White'
    Write-Host ''
    Write-Host ''
    Write-Host '  Quit Freebuff completely - right-click its tray icon and exit, or end'
    Write-Host '  Freebuff.exe in Task Manager - then run this again.'
    Write-Host ''
    Write-Host '  Windows will not replace a file another process is holding, and this'
    Write-Host '  tool will not force it.'
  } else {
    Write-Piece 'Windows is not letting this write go through.' 'White'
    Write-Host ''
    Write-Host ''
    if ($message) {
      Write-Host "  $message"
      Write-Host ''
    }
    Write-Host '  If Freebuff is installed for everyone (under C:\Program Files), open a'
    Write-Host '  PowerShell window with "Run as administrator" and run the same command'
    Write-Host '  again. A per-user install (under %LOCALAPPDATA%\Programs) never needs'
    Write-Host '  that.'
    Write-Host ''
    Write-Host '  If the file is marked read-only, clear it first:'
    Write-Host "    attrib -R `"$Target`""
    Write-Host ''
    Write-Host '  Antivirus and Controlled Folder Access can refuse this too. The tool'
    Write-Host '  never asks for a password and never elevates by itself.'
  }
  Write-Host ('-' * 44)
}

function Get-ScanHint {
  Write-Host '  See what this build actually has:'
  Write-Host '    powershell -ExecutionPolicy Bypass -File .\freebuff-adblock.ps1 scan'
  Write-Host "    `$s = irm $Origin/downloads/freebuff-adblock-desktop.ps1; & ([scriptblock]::Create(`$s)) scan"
  Write-Host '  Read-only either way. The piped one is for when you ran the one-liner and'
  Write-Host '  have no local copy to point at.'
}

# ------------------------------------------------------------------- commands

function Show-Version {
  Say "freebuff-adblock-desktop $Version"
  Say $Origin
}

function Show-Help {
  Say "Freebuff AdBlock for Desktop (Windows) $Version"
  Say 'Blocks the ads Freebuff Desktop renders from its bundled orchestrator.'
  Say ''
  Say 'usage'
  Say "  irm $Origin/downloads/freebuff-adblock-desktop.ps1 | iex"
  Say "  `$s = irm $Origin/downloads/freebuff-adblock-desktop.ps1"
  Say '  & ([scriptblock]::Create($s)) [command] [options]'
  Say ''
  Say 'commands'
  Say '  install   patch the app (default; backs up first)'
  Say '  status    report what is applied - changes nothing'
  Say '  verify    wait for Freebuff to be relaunched, then check what it loaded'
  Say '  scan      show every anchor this build has - changes nothing'
  Say '  revert    restore the pristine backup'
  Say '  doctor    environment report'
  Say '  version   print the tool version'
  Say ''
  Say 'options'
  Say '  -App PATH          the Freebuff install folder (auto-detected by default)'
  Say '  -BackupDir PATH    where the pristine copy lives'
  Say '  -DisplayOnly       skip the ad-API anchor (leave the render gate only)'
  Say '  -DryRun            report only, write nothing'
  Say '  -NoWait            verify: report now instead of waiting for the relaunch'
  Say '  -Timeout SECONDS   how long verify waits (default 300)'
  Say ''
  Say 'A patch on disk is not the same as a patch in effect: the orchestrator is'
  Say 'read once at launch. verify waits for the relaunch and reports the two times'
  Say 'that decide it - when the patch was written and when the process running now'
  Say 'started. install does that for you whenever Freebuff is open. The wait is'
  Say 'bounded by -Timeout, and Ctrl-C ends it at once - nothing either does writes'
  Say 'to the app, and an interrupted wait prints no verdict.'
  Say ''
  Say 'After any Freebuff update, run install again - an update replaces the whole'
  Say 'resources folder and the patch goes with it.'
  Say ''
  Say 'Each anchor has a literal form and a relaxed one. The relaxed form is only'
  Say 'used when it is found the expected number of times and ad code sits beside it,'
  Say 'and a write is undone if the check afterwards disagrees. If a patch reports'
  Say 'not found, scan lists what this build does have.'
}

function Get-RequiredApp {
  $appDir = Find-AppDir
  if (-not $appDir) {
    Die "Freebuff Desktop was not found.`n  Pass -App with its install folder, for example:`n    -App `"$env:LOCALAPPDATA\Programs\@codebufffreebuff-desktop`""
  }
  return $appDir
}

function Get-RequiredTarget {
  param([string] $AppDir)
  $target = Get-TargetPath $AppDir
  if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
    Die "no resources\orchestrator\orchestrator.js in $AppDir - is that the Freebuff install folder?"
  }
  return $target
}

function Invoke-Status {
  $appDir = Get-RequiredApp
  $target = Get-RequiredTarget $appDir
  $appVersion = Get-AppVersion $appDir

  Say "Freebuff Ad Block - desktop tool $Version"
  Say "  app      $appDir"
  Say "  version  $appVersion"
  Say "  target   $target"
  Say ''

  $result = Invoke-Engine -Mode check -Target $target -DeepScan $Deep
  Show-Report $result

  if ($result.Verdict -eq 'ok') {
    if (Test-AllApplied $result) {
      Say ''
      Say '  Ads are off. Quit Freebuff and reopen it, then check what it loaded:'
      Say '    powershell -ExecutionPolicy Bypass -File .\freebuff-adblock.ps1 verify'
    } else {
      Say ''
      Say '  Not patched yet. Run: powershell -ExecutionPolicy Bypass -File .\freebuff-adblock.ps1 install'
    }
    exit 0
  }

  Say ''
  Bad 'This orchestrator.js does not match what the tool expects.'
  Say '  Either it was already modified by another tool, or this Freebuff version'
  Say '  changed the file. Nothing was written.'
  Say ''
  Say '  See what this build actually has:'
  Say '    powershell -ExecutionPolicy Bypass -File .\freebuff-adblock.ps1 scan'
  Say ''
  $backup = Join-Path $BackupDir "orchestrator.js.$appVersion.orig"
  if (Test-Path -LiteralPath $backup -PathType Leaf) {
    Say '  A pristine backup exists. Restore it, then install again:'
    Say '    powershell -ExecutionPolicy Bypass -File .\freebuff-adblock.ps1 revert'
  } else {
    Say '  If you patched this by hand before, restore the original file first.'
  }
  exit 1
}

function Invoke-Install {
  $appDir = Get-RequiredApp
  $target = Get-RequiredTarget $appDir
  $appVersion = Get-AppVersion $appDir

  Say "Freebuff Ad Block - desktop tool $Version"
  Say "  app      $appDir"
  Say "  version  $appVersion"
  Say ''

  $result = Invoke-Engine -Mode check -Target $target -DeepScan $Deep

  if ($result.Verdict -ne 'ok') {
    Show-Report $result
    Say ''
    Bad "Refusing to patch - the file does not match this tool's expectations."
    Say '  Nothing was written. Either it was modified by another tool, or this'
    Say '  Freebuff version changed the ad code.'
    Say ''
    Get-ScanHint
    Say ''
    $backup = Join-Path $BackupDir "orchestrator.js.$appVersion.orig"
    if (Test-Path -LiteralPath $backup -PathType Leaf) {
      Say '  A pristine backup is on disk:'
      Say '    powershell -ExecutionPolicy Bypass -File .\freebuff-adblock.ps1 revert'
    }
    exit 1
  }

  if (Test-AllApplied $result) {
    Say '  Already patched. Nothing to do.'
    Say '  Quit Freebuff and reopen it if ads are still showing.'
    exit 0
  }

  Say '  Would patch:'
  Show-Report $result
  Say ''

  if ($Dry) {
    Say '  -DryRun: nothing was written.'
    exit 0
  }

  if ((Get-Item -LiteralPath $target).IsReadOnly) {
    Bad 'the file is marked read-only'
    Show-WriteHelp -Target $target
    exit 1
  }

  if (-not (Test-CanWrite -Target $target)) {
    Show-WriteHelp -Target $target
    exit 1
  }

  if (-not (Test-Path -LiteralPath $BackupDir -PathType Container)) {
    try { New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null }
    catch { Die "cannot create the backup folder ${BackupDir}: $($_.Exception.Message)" }
  }

  $backup = Join-Path $BackupDir "orchestrator.js.$appVersion.orig"
  if (Test-Path -LiteralPath $backup -PathType Leaf) {
    Say "  backup   kept $backup"
  } else {
    try {
      Copy-Item -LiteralPath $target -Destination $backup -Force -ErrorAction Stop
    } catch {
      Show-WriteHelp -Target $target -ErrorRecord $_
      exit 1
    }
    Say "  backup   $backup"
  }

  Say ''
  $applied = $null
  try {
    $applied = Invoke-Engine -Mode apply -Target $target -DeepScan $Deep
  } catch {
    Bad 'the patch did not apply cleanly - the file was left untouched'
    Show-WriteHelp -Target $target -ErrorRecord $_
    exit 1
  }

  if (-not $applied.Written) {
    Bad 'the patch did not apply cleanly - the file was left untouched'
    Show-Report $applied
    exit 1
  }

  $after = Invoke-Engine -Mode check -Target $target -DeepScan $Deep

  # A relaxed anchor is an inference, not a literal this tool was verified against,
  # so the write only stands if a fresh count agrees with it. If it does not, the
  # pristine copy goes straight back - a half-patched bundle is the one outcome
  # worth undoing.
  if ($after.Verdict -ne 'ok' -or -not (Test-AllApplied $after)) {
    Show-Report $after
    Say ''
    Bad 'the patch did not verify after writing - putting the original back'
    try {
      Copy-Item -LiteralPath $backup -Destination $target -Force -ErrorAction Stop
      Ok "restored $target"
    } catch {
      Bad "could not restore $target - copy it back by hand: $backup"
    }
    exit 1
  }

  Show-Report $after
  Say ''

  Ok "patched Freebuff $appVersion"
  Write-Host ('-' * 44)

  $running = @(Get-OrchestratorProcesses -AppDir $appDir -Target $target).Count -gt 0

  if ($running) {
    Write-Piece 'Freebuff is running. Quit it completely and reopen it.' 'White'
    Write-Host ''
    Say 'The orchestrator is read once at launch, so the patch only takes effect on'
    Say 'the next start - focusing the window is not enough.'
    Say ''
    # Only when there is a relaunch to wait for. A closed app has nothing to
    # observe, and an unattended install must not sit here for five minutes.
    if ($Wait) {
      Wait-ForRelaunch -AppDir $appDir -Target $target | Out-Null
    } else {
      Say '  Then check what it loaded:'
      Say '    powershell -ExecutionPolicy Bypass -File .\freebuff-adblock.ps1 verify'
    }
  } else {
    Write-Piece 'Open Freebuff.' 'White'
    Write-Host ''
    Say 'The patch takes effect on the next launch.'
    Say '  Then check what it loaded:'
    Say '    powershell -ExecutionPolicy Bypass -File .\freebuff-adblock.ps1 verify'
  }
  Say ''
  Say 'Undo any time:  powershell -ExecutionPolicy Bypass -File .\freebuff-adblock.ps1 revert'
  Say 'After a Freebuff update, re-run install.'
  exit 0
}

function Invoke-Revert {
  $appDir = Get-RequiredApp
  $target = Get-RequiredTarget $appDir
  $appVersion = Get-AppVersion $appDir
  $backup = Join-Path $BackupDir "orchestrator.js.$appVersion.orig"

  if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) {
    Say "No backup for $appVersion in $BackupDir"
    if (Test-Path -LiteralPath $BackupDir -PathType Container) {
      Say 'Available backups:'
      foreach ($file in @(Get-ChildItem -LiteralPath $BackupDir -Filter 'orchestrator.js.*.orig' -ErrorAction SilentlyContinue)) {
        Say "  $($file.FullName)"
      }
    }
    Die 'nothing to restore'
  }

  if (-not (Test-CanWrite -Target $target)) {
    Show-WriteHelp -Target $target
    exit 1
  }

  try {
    Copy-Item -LiteralPath $backup -Destination $target -Force -ErrorAction Stop
  } catch {
    Show-WriteHelp -Target $target -ErrorRecord $_
    exit 1
  }

  Ok "restored $target from $backup"
  Say '  Quit Freebuff and reopen it to bring the ads back.'
  exit 0
}

function Invoke-Doctor {
  Say "freebuff-adblock-desktop $Version"
  Say "  origin        $Origin"
  Say "  os            $([System.Environment]::OSVersion.VersionString)"
  Say "  powershell    $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition))"
  Say "  windows       $($script:IsWindowsOS)"
  Say "  backup dir    $BackupDir"
  Say ''

  $candidates = Get-AppCandidates
  Say "  looked in     $($candidates.Count) location(s)"
  $shown = 0
  foreach ($candidate in $candidates) {
    if ($shown -ge 10) {
      Say "                ... and $($candidates.Count - $shown) more"
      break
    }
    $shown++
    $mark = ''
    if (Test-Path -LiteralPath (Get-TargetPath $candidate) -PathType Leaf) { $mark = ' <- has orchestrator.js' }
    Say "                $candidate$mark"
  }
  Say ''

  $appDir = Find-AppDir
  if (-not $appDir) {
    Bad 'Freebuff Desktop was not found'
    exit 1
  }

  $target = Get-TargetPath $appDir
  $appVersion = Get-AppVersion $appDir
  Say "  app           $appDir"
  Say "  version       $appVersion"
  Say "  orchestrator  $target"

  if (Test-Path -LiteralPath $target -PathType Leaf) {
    Say "  size          $((Get-Item -LiteralPath $target).Length) bytes"
    if (Test-CanWrite -Target $target) { Ok 'bundle is writable' }
    else { Bad 'bundle is NOT writable (needs an elevated shell, or the file is locked)' }

    Show-Report (Invoke-Engine -Mode check -Target $target -DeepScan $Deep)
  } else {
    Bad 'orchestrator.js is missing'
  }

  $processes = Get-OrchestratorProcesses -AppDir $appDir -Target $target
  if ($processes.Count -gt 0) {
    Warn "Freebuff is running ($($processes.Count) matching process(es))"
  } else {
    Ok 'Freebuff is not running'
  }
  exit 0
}

function Invoke-Scan {
  $appDir = Get-RequiredApp
  $target = Get-RequiredTarget $appDir
  $appVersion = Get-AppVersion $appDir

  Say "Freebuff Ad Block - anchor scan (tool $Version)"
  Say "  app      $appDir"
  Say "  version  $appVersion"
  Say "  target   $target"
  Say ''

  $report = Get-ScanReport -Target $target -AppDir $appDir -DeepScan $Deep

  Write-Host -NoNewline $report
  Say ''

  $out = Join-Path $BackupDir "orchestrator-scan.$appVersion.txt"
  $saved = $false
  try {
    if (-not (Test-Path -LiteralPath $BackupDir -PathType Container)) {
      New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
    }
    [System.IO.File]::WriteAllText($out, $report, (New-Object System.Text.UTF8Encoding($false)))
    $saved = $true
  } catch {
    $saved = $false
  }

  if ($saved) {
    Ok "saved    $out"
    Say '  Nothing inside the app was touched. When a patch reports'
    Write-Host -NoNewline '  '
    Write-Piece 'not found' 'White'
    Say ', this file is what re-anchoring the tool needs.'
  } else {
    Warn "could not write $out - copy the block above instead"
  }
  exit 0
}

function Invoke-Verify {
  $appDir = Get-RequiredApp
  $target = Get-RequiredTarget $appDir
  $appVersion = Get-AppVersion $appDir

  Say "Freebuff Ad Block - desktop tool $Version"
  Say "  app      $appDir"
  Say "  version  $appVersion"
  Say "  target   $target"
  Say ''

  $result = Invoke-Engine -Mode check -Target $target -DeepScan $Deep

  if ($result.Verdict -ne 'ok') {
    Show-Report $result
    Say ''
    Bad 'This orchestrator.js does not match what the tool expects.'
    Say "  There is nothing of this tool's to verify, and nothing was written."
    Say ''
    Say '  See what this build actually has:'
    Say '    powershell -ExecutionPolicy Bypass -File .\freebuff-adblock.ps1 scan'
    exit 1
  }

  if (-not (Test-AllApplied $result)) {
    Show-Report $result
    Say ''
    Say '  Not patched yet. Run:'
    Say '    powershell -ExecutionPolicy Bypass -File .\freebuff-adblock.ps1 install'
    exit 1
  }

  Show-Report $result
  Say ''
  # `-contains` rather than an equality test: a stray value on this function's
  # output stream must not be able to turn a refusal into a success, and a scalar
  # on the left of -contains is read as a one-element list.
  $verified = Wait-ForRelaunch -AppDir $appDir -Target $target
  if ($verified -contains 0) { exit 0 }
  exit 1
}

# What no file can answer: whether the app you are looking at loaded the patched
# file. The orchestrator is read once at launch, so the one honest test is a
# comparison of two times: when the patch was written, and when the process that is
# running now started. Started later means the patched file is what it read.
function Wait-ForRelaunch {
  param([string] $AppDir, [string] $Target)

  $patchTime = Get-PatchTime -Target $Target
  $remaining = $WaitSecs
  $announced = $false
  $waiting = $false

  # Every statement in here is assigned or piped to Out-Null on purpose: this
  # function's return value *is* the command's exit status, and one stray value on
  # the output stream is enough to turn a refusal into a success. That is not
  # hypothetical - it happened, through a method reference that looked inert.
  #
  # Ctrl-C is deliberately not intercepted, and that is a measurement, not a
  # preference. A CancelKeyPress handler written as a PowerShell script block
  # cannot run: the signal arrives on a thread with no runspace, so PowerShell
  # answers with an unhandled PSInvalidOperationException and the process dies of
  # SIGABRT - a handler here is worse than no handler. A compiled .NET delegate
  # (Add-Type) does run, but it buys nothing: PowerShell still reports exit 0 for
  # an interrupted run and ignores Environment.Exit() from that thread, so the
  # handler could print but never set a status. Ctrl-C therefore ends the run the
  # moment it arrives - no verdict, no message - and the exit code on that path
  # belongs to the host. What brings an unattended run back is the bound below.
  while ($true) {
    $bestId = 0
    $bestStart = $null
    foreach ($process in (Get-OrchestratorProcesses -AppDir $AppDir -Target $Target)) {
      if (-not $process.Start) { continue }
      if ((-not $bestStart) -or ($process.Start -gt $bestStart)) {
        $bestId = $process.Id
        $bestStart = $process.Start
      }
    }

    # Two seconds of tolerance, and both seconds are the clock's fault: a process
    # started immediately after the write can read as a second before it. No real
    # relaunch is ever that close to the patch, and a false "relaunch and run this
    # again" is worse than a false pass in a window two seconds wide.
    if ($bestId -and $patchTime) {
      $delta = [int]($bestStart.ToUnixTimeSeconds() - $patchTime.ToUnixTimeSeconds())
      if ($delta -ge -2) {
        Say "  running    pid $bestId, started $(Get-FriendlyTime $bestStart)"
        Say "             $(Get-ClockWords $delta)"
        $ad = Get-AdCodeLine -Target $Target
        if ($ad) {
          Say "  ad code    still in this build: $ad"
        } else {
          Warn 'the ad runtime this patch aims at is not in this build'
          Say '             Freebuff may have removed it, or moved it. scan lists'
          Say '             every site this build does have.'
        }
        Say ''
        Ok 'the running app is the patched file'
        Say '  The ad auction in it returns no ads, and the ad client gives up before'
        Say '  it sends. What no check here can see is whether an ad break still'
        Say '  appears - only you can. On the free tier, run a turn: an ad card is'
        Say '  the one carrying an "AD" chip or a /track/click link.'
        return 0
      }
    }

    # Why not, said once, so a long wait does not repeat itself.
    if (-not $announced) {
      if (-not $bestId) {
        Say '  running    Freebuff is not open.'
      } elseif (-not $patchTime) {
        Say "  running    pid $bestId, started $(Get-FriendlyTime $bestStart)"
        Say '             the patch time could not be read, so the two cannot be compared'
      } else {
        Say "  running    pid $bestId, started $(Get-FriendlyTime $bestStart)"
        Say "             $(Get-ClockWords $delta)"
      }
      $announced = $true
    }

    if (-not $Wait) {
      Say ''
      Say '  Not verified. This check needs Freebuff running the patched file.'
      Say '  Quit it completely, reopen it, then run it again:'
      Say '    powershell -ExecutionPolicy Bypass -File .\freebuff-adblock.ps1 verify'
      return 1
    }

    if (-not $waiting) {
      Say ''
      Write-Host -NoNewline '  Waiting for Freebuff to be quit and reopened...  '
      Write-Piece '(Ctrl-C stops it, with no verdict)' 'DarkGray'
      Say ''
      $waiting = $true
    }

    if ($remaining -le 0) {
      Say ''
      Say '  Stopped waiting. The patch itself is fine - this check only needs the'
      Say '  relaunch. Run it again once Freebuff is open:'
      Say '    powershell -ExecutionPolicy Bypass -File .\freebuff-adblock.ps1 verify'
      return 1
    }

    Start-Sleep -Seconds 2
    $remaining -= 2
  }
}

# ------------------------------------------------------------------------ run

switch ($Command) {
  'install' { Invoke-Install }
  'status' { Invoke-Status }
  'verify' { Invoke-Verify }
  'revert' { Invoke-Revert }
  'doctor' { Invoke-Doctor }
  'scan' { Invoke-Scan }
  'version' { Show-Version; exit 0 }
  'help' { Show-Help; exit 0 }
  default { Die "unknown command: $Command  (try help)" }
}
