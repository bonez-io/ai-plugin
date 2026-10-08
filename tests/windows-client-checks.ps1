<#
.SYNOPSIS
  Checks that the Bonez ai-plugin works on THIS Windows machine. Prints PASS / FAIL / SKIP with evidence.

.DESCRIPTION
  Run it from a checkout of https://github.com/bonez-io/ai-plugin (the branch you want to validate):

      powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-client-checks.ps1
      pwsh -NoProfile -File .\tests\windows-client-checks.ps1

  Works in Windows PowerShell 5.1 and PowerShell 7. ASCII only, no modules, no admin rights.
  Exit code 0 = no FAIL (SKIP is not a failure), 1 = at least one FAIL.

  It checks: Git Bash and `bash` on PATH, node and bun, the claude / codex / cursor CLIs, that the
  documented PowerShell snippets pass their quoting through intact, that the checkout is LF, that
  bin\bonez-package-hash.mjs reproduces the shared vectors, that junctions are refused, that
  bin\bonez-plugin-push.mjs uploads a fixture to a fake gateway, that the write gate runs under Git
  Bash and prompts for a simulated write (Claude Code and Cursor forms, from a path with a space), that
  bin\bonez-session-sync.mjs runs from a path with a space, and the repo's own node tests.

  NO NETWORK: the only socket it opens is the fake gateway on 127.0.0.1 (tests\lib\push-smoke.mjs). The
  claude / codex / cursor calls are `--version` only. It writes only under %TEMP% and deletes it.

.PARAMETER PluginRoot
  The ai-plugin checkout. Default: the folder above this script, else the current folder.
#>
[CmdletBinding()]
param([string]$PluginRoot)

$ErrorActionPreference = 'Continue'

# ---- helpers ----------------------------------------------------------------------------------------

# Join-Path with several segments (Windows PowerShell 5.1's Join-Path takes only two).
function P {
  param([string]$Base, [string[]]$Rest)
  $r = $Base
  foreach ($x in $Rest) { $r = Join-Path $r $x }
  return $r
}

# One command-line string from separate arguments, the way the Windows C runtime parses it back.
function ConvertTo-ArgString {
  param([string[]]$ArgList)
  $parts = foreach ($a in $ArgList) {
    if ($a -eq '') { '""' }
    elseif ($a -notmatch '[\s"]') { $a }
    else {
      $s = $a -replace '(\\*)"', '$1$1\"'
      $s = $s -replace '(\\+)$', '$1$1'
      '"' + $s + '"'
    }
  }
  return ($parts -join ' ')
}

# Start a program with EXACT arguments (no PowerShell argument parsing in between), optional stdin and
# environment, a timeout. Returns @{ ExitCode; Out; Err }.
function Invoke-Native {
  param(
    [string]$File,
    [string[]]$ArgList = @(),
    [string]$InputText = $null,
    [hashtable]$EnvVars = @{},
    [string]$WorkDir = $null,
    [int]$TimeoutSec = 180
  )
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $File
  $psi.Arguments = ConvertTo-ArgString $ArgList
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  if ($WorkDir) { $psi.WorkingDirectory = $WorkDir }
  foreach ($k in $EnvVars.Keys) {
    if ($null -eq $EnvVars[$k]) { [void]$psi.EnvironmentVariables.Remove([string]$k) }
    else { $psi.EnvironmentVariables[[string]$k] = [string]$EnvVars[$k] }
  }
  $p = [System.Diagnostics.Process]::Start($psi)
  $outTask = $p.StandardOutput.ReadToEndAsync()
  $errTask = $p.StandardError.ReadToEndAsync()
  if ($null -ne $InputText) {
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($InputText)   # explicit bytes: no BOM
    $p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
  }
  $p.StandardInput.Close()
  if (-not $p.WaitForExit($TimeoutSec * 1000)) {
    try { $p.Kill() } catch { }
    return @{ ExitCode = -1; Out = ''; Err = "timed out after $TimeoutSec s" }
  }
  $p.WaitForExit()
  return @{ ExitCode = $p.ExitCode; Out = $outTask.Result; Err = $errTask.Result }
}

function Show-Text {
  param([string]$Text, [int]$Max = 12)
  $lines = @(($Text -replace "`r", '') -split "`n" | Where-Object { $_ -ne '' })
  if ($lines.Count -gt $Max) { $lines = @($lines[0..($Max - 1)]) + "... ($($lines.Count - $Max) more lines)" }
  return ($lines -join "`n")
}

$script:Pass = 0; $script:Fail = 0; $script:Skip = 0
function Pass { param([string]$Evidence) return @{ Status = 'PASS'; Evidence = $Evidence } }
function Fail { param([string]$Evidence) return @{ Status = 'FAIL'; Evidence = $Evidence } }
function Skip { param([string]$Evidence) return @{ Status = 'SKIP'; Evidence = $Evidence } }

function Check {
  param([string]$Name, [scriptblock]$Body)
  try {
    $r = @(& $Body)[-1]
    if ($null -eq $r -or -not $r.Status) { $r = Fail 'the check returned nothing' }
  } catch {
    $r = Fail ('exception: ' + $_.Exception.Message)
  }
  switch ($r.Status) { 'PASS' { $script:Pass++ } 'FAIL' { $script:Fail++ } default { $script:Skip++ } }
  Write-Host ('{0} {1}' -f $r.Status, $Name)
  foreach ($line in (([string]$r.Evidence) -replace "`r", '') -split "`n") { if ($line -ne '') { Write-Host ('       ' + $line) } }
}

# ---- setup ------------------------------------------------------------------------------------------

function Find-PluginRoot {
  $candidates = @()
  if ($PluginRoot) { $candidates += $PluginRoot }
  if ($PSScriptRoot) { $candidates += (Split-Path -Parent $PSScriptRoot); $candidates += $PSScriptRoot }
  $candidates += (Get-Location).Path
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath (P $c @('bin', 'bonez-package-hash.mjs')))) { return (Resolve-Path -LiteralPath $c).Path }
  }
  return $null
}

$Root = Find-PluginRoot
if (-not $Root) {
  Write-Host 'FAIL setup'
  Write-Host '       cannot find the ai-plugin checkout (no bin\bonez-package-hash.mjs). Pass -PluginRoot <folder>,'
  Write-Host '       or run this from inside a clone of bonez-io/ai-plugin.'
  exit 1
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$Node = if ($nodeCmd) { $nodeCmd.Source } else { $null }
$bunCmd = Get-Command bun -ErrorAction SilentlyContinue
$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('bonez-win-checks-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null

Write-Host "windows-client-checks: PowerShell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition)) on $([System.Environment]::OSVersion.VersionString)"
Write-Host "windows-client-checks: plugin checkout $Root"
Write-Host "windows-client-checks: scratch folder $Tmp"
Write-Host ''

try {
  # A copy of the plugin under a path with a space (a user name with a space is common): the hook and tool
  # checks run from here.
  $Spaced = P $Tmp @('Jane Doe', 'plug in')
  New-Item -ItemType Directory -Force -Path $Spaced | Out-Null
  foreach ($d in @('bin', 'hooks', 'cursor', 'tests')) { Copy-Item -LiteralPath (P $Root @($d)) -Destination (P $Spaced @($d)) -Recurse -Force }

  # ---- the machine ----------------------------------------------------------------------------------

  $GitBash = $null
  Check 'Git for Windows and Git Bash are installed (Claude Code runs hooks and its shell tool through Git Bash)' {
    $candidates = @()
    if ($env:CLAUDE_CODE_GIT_BASH_PATH) { $candidates += $env:CLAUDE_CODE_GIT_BASH_PATH }
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, (Join-Path $env:LOCALAPPDATA 'Programs'))) {
      if ($base) { $candidates += (P $base @('Git', 'bin', 'bash.exe')) }
    }
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($git) { $candidates += (P (Split-Path -Parent (Split-Path -Parent $git.Source)) @('bin', 'bash.exe')) }
    $found = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
    if (-not $found) { return (Fail ("no Git Bash found (looked at: " + (($candidates | Where-Object { $_ }) -join '; ') + ").`nFix: winget install --id Git.Git -e")) }
    $script:GitBash = $found
    $v = Invoke-Native $found @('--version')
    if ($v.ExitCode -ne 0) { return (Fail "$found --version exited $($v.ExitCode): $($v.Err)") }
    return (Pass ("$found`n" + (Show-Text $v.Out 1)))
  }

  Check '`bash` on PATH is Git Bash (Cursor runs `bash ./hooks/gate-write.sh`; without it Cursor lets writes through unprompted)' {
    $all = @(Get-Command bash -All -ErrorAction SilentlyContinue)
    if ($all.Count -eq 0) {
      return (Fail "no `bash` on PATH. Fix: add the folder of Git's bash.exe to PATH (C:\Program Files\Git\bin), or install Git with the 'Use Git and optional Unix tools from the Command Prompt' PATH option.")
    }
    $first = $all[0].Source
    $list = ($all | ForEach-Object { $_.Source }) -join "`n"
    if ($first -match '\\Windows\\System32\\bash\.exe$') {
      return (Fail "the first `bash` on PATH is the WSL launcher, not Git Bash:`n$list`nFix: put C:\Program Files\Git\bin before C:\Windows\System32 in PATH.")
    }
    if ($first -notmatch '\\Git\\') { return (Fail "the first `bash` on PATH is not under a Git folder:`n$list") }
    return (Pass $list)
  }

  Check 'node 18 or newer (the hash and push tools, the hooks of session capture)' {
    if (-not $Node) { return (Fail 'node is not on PATH. Fix: winget install --id OpenJS.NodeJS.LTS -e (then open a new terminal)') }
    $v = Invoke-Native $Node @('--version')
    $major = [int](($v.Out.Trim() -replace '^v', '') -split '\.')[0]
    if ($major -lt 18) { return (Fail "node $($v.Out.Trim()) is older than 18") }
    return (Pass "$Node $($v.Out.Trim())")
  }

  Check 'bun (the plugin creator: bun install / test / build:package; Bonez pins 1.3.14)' {
    if (-not $bunCmd) { return (Fail 'bun is not on PATH. Fix: winget install --id Oven-sh.Bun --exact --version 1.3.14 (then open a new terminal)') }
    $v = Invoke-Native $bunCmd.Source @('--version')
    $note = if ($v.Out.Trim() -eq '1.3.14') { '' } else { ' (Bonez pins 1.3.14; the creator warns and continues)' }
    return (Pass "$($bunCmd.Source) $($v.Out.Trim())$note")
  }

  foreach ($cli in @('claude', 'codex', 'cursor')) {
    $name = $cli
    Check "$name is on PATH (SKIP if you do not use that client)" {
      $c = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
      if (-not $c) { return (Skip "$name not on PATH") }
      # `--version` through cmd.exe so a .cmd shim (npm installs codex that way) starts too.
      $r = Invoke-Native 'cmd.exe' @('/c', ('"' + $c.Source + '" --version')) -TimeoutSec 60
      if ($r.ExitCode -ne 0) { return (Fail "$($c.Source) --version exited $($r.ExitCode): $(Show-Text $r.Err 3)") }
      return (Pass "$($c.Source)`n$(Show-Text $r.Out 2)")
    }
  }

  # ---- the documented PowerShell snippets -----------------------------------------------------------

  Check 'snippet: JSON piped to a program (claude plugin configure --values-stdin) arrives byte for byte' {
    if (-not $Node) { return (Skip 'no node') }
    $want = '{"bonez_url":"https://bonez.example.com"}'
    $got = (@($want | & $Node -e "process.stdin.pipe(process.stdout)") -join "`n").Trim()
    if ($got -ne $want) { return (Fail "sent:     $want`nreceived: $got") }
    return (Pass "received $got")
  }

  Check 'snippet: --header "Authorization: Bearer $env:BONEZ_API_KEY" arrives as ONE argument with the value expanded' {
    if (-not $Node) { return (Skip 'no node') }
    $old = $env:BONEZ_API_KEY
    try {
      $env:BONEZ_API_KEY = 'bnz_test_key'
      $got = (@(& $Node -e "console.log(process.argv.slice(1).join('|'))" -- --header "Authorization: Bearer $env:BONEZ_API_KEY") -join "`n").Trim()
    } finally {
      if ($null -eq $old) { Remove-Item Env:\BONEZ_API_KEY -ErrorAction SilentlyContinue } else { $env:BONEZ_API_KEY = $old }
    }
    $want = '--header|Authorization: Bearer bnz_test_key'
    if ($got -ne $want) { return (Fail "wanted:   $want`nreceived: $got") }
    return (Pass "received $got")
  }

  Check 'why the README gives no `cursor --add-mcp ''{json}''` on Windows: a .cmd shim loses the inner double quotes' {
    if (-not $Node) { return (Skip 'no node') }
    # cursor is a .cmd shim on Windows; this one forwards its arguments to node the same way.
    $shim = P $Tmp @('shim', 'addmcp.cmd')
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $shim) | Out-Null
    [System.IO.File]::WriteAllText($shim, "@echo off`r`n`"$Node`" -e `"console.log(process.argv[1])`" %*`r`n")
    $want = '{"name":"bonez","url":"https://bonez.example.com/mcp"}'
    $got = (@(& $shim $want) -join "`n").Trim()
    if ($got -eq $want) { return (Fail "the quotes survived ($got): the README's reason for avoiding --add-mcp does not hold on this shell, re-read it") }
    return (Pass "typed:    $want`nreceived: $got   (not JSON: use the one-click link or %USERPROFILE%\.cursor\mcp.json)")
  }

  # ---- the checkout ---------------------------------------------------------------------------------

  Check 'the checkout is LF, not CRLF (Git for Windows defaults to core.autocrlf=true; .gitattributes must win)' {
    $exts = '.sh', '.mjs', '.json', '.md', '.toml', '.yml', '.ps1', '.jsonl', '.svg', '.ts'
    $bad = @()
    $count = 0
    Get-ChildItem -LiteralPath $Root -Recurse -File -Force |
      Where-Object { $exts -contains $_.Extension.ToLower() -and $_.FullName -notmatch '[\\/]\.git[\\/]' } |
      ForEach-Object {
        $count++
        if ([Array]::IndexOf([System.IO.File]::ReadAllBytes($_.FullName), [byte]13) -ge 0) { $bad += $_.FullName.Substring($Root.Length + 1) }
      }
    if ($bad.Count -gt 0) {
      return (Fail ("$($bad.Count) of $count files contain CR, first: " + (($bad | Select-Object -First 5) -join ', ') + "`nA .sh with CRLF fails as `"bash\r`" and the write gate then lets writes through. Re-clone, or: git add --renormalize . ; git checkout -- ."))
    }
    return (Pass "$count text files, none with a carriage return")
  }

  # ---- the hash tool on the shared vectors ----------------------------------------------------------

  $vectorFile = P $Root @('tests', 'fixtures', 'plugin-tree.json')
  $vectors = @()
  if (Test-Path -LiteralPath $vectorFile) { $vectors = @((Get-Content -Raw -Encoding UTF8 -LiteralPath $vectorFile | ConvertFrom-Json).vectors) }
  foreach ($v in $vectors) {
    $vec = $v
    Check "bonez-package-hash equals the gateway's hash for the shared vector '$($vec.name)'" {
      if (-not $Node) { return (Skip 'no node') }
      $dir = P $Tmp @(('vec-' + $vec.name))
      foreach ($prop in $vec.files.PSObject.Properties) {
        $abs = Join-Path $dir ($prop.Name -replace '/', '\')
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $abs) | Out-Null
        [System.IO.File]::WriteAllBytes($abs, [System.Convert]::FromBase64String([string]$prop.Value))
      }
      $r = Invoke-Native $Node @((P $Spaced @('bin', 'bonez-package-hash.mjs')), $dir)
      if ($r.ExitCode -ne 0) { return (Fail "exit $($r.ExitCode): $($r.Err)") }
      if ($r.Out.Trim() -ne $vec.tree_sha256) { return (Fail "expected $($vec.tree_sha256)`ngot      $($r.Out.Trim())") }
      return (Pass "$($vec.tree_sha256) (run from a path with a space, folder walked with Windows paths)")
    }
  }
  if ($vectors.Count -eq 0) { Check 'the shared vectors file is present' { Fail "no vectors in $vectorFile" } }

  Check 'bonez-package-hash refuses a directory junction like a symlink' {
    if (-not $Node) { return (Skip 'no node') }
    $dir = P $Tmp @('junction')
    New-Item -ItemType Directory -Force -Path (P $dir @('real')) | Out-Null
    [System.IO.File]::WriteAllText((P $dir @('package.json')), '{}')
    [System.IO.File]::WriteAllText((P $dir @('real', 'x.js')), 'x')
    New-Item -ItemType Junction -Path (P $dir @('link')) -Target (P $dir @('real')) | Out-Null
    $r = Invoke-Native $Node @((P $Spaced @('bin', 'bonez-package-hash.mjs')), $dir)
    if ($r.ExitCode -ne 1 -or $r.Err -notmatch 'symlink not allowed: link') { return (Fail "exit $($r.ExitCode), stdout '$($r.Out.Trim())', stderr '$($r.Err.Trim())'") }
    return (Pass $r.Err.Trim())
  }

  # ---- the push tool against a fake gateway on 127.0.0.1 --------------------------------------------

  Check 'bonez-plugin-push uploads a fixture to a fake gateway and prints name, version, fingerprint, computers (127.0.0.1 only)' {
    if (-not $Node) { return (Skip 'no node') }
    $r = Invoke-Native $Node @((P $Spaced @('tests', 'lib', 'push-smoke.mjs')))
    if ($r.ExitCode -ne 0) { return (Fail ("exit $($r.ExitCode)`n" + (Show-Text ($r.Out + $r.Err) 40))) }
    return (Pass (Show-Text $r.Out 20))
  }

  # ---- the write gate under Git Bash ----------------------------------------------------------------

  $claudeWrite = '{"hook_event_name":"PreToolUse","tool_name":"mcp__plugin_bonez_bonez__graph_write","tool_input":{"op":"remember","content":"x"}}'
  $claudeRead = '{"hook_event_name":"PreToolUse","tool_name":"mcp__plugin_bonez_bonez__graph_search","tool_input":{"query":"x"}}'
  $hooksJson = Get-Content -Raw -Encoding UTF8 -LiteralPath (P $Root @('hooks', 'hooks.json')) | ConvertFrom-Json
  $gateCommand = $hooksJson.hooks.PreToolUse[0].hooks[0].command

  foreach ($form in @('backslashes', 'forward slashes')) {
    $f = $form
    Check "Claude Code hook: the exact hooks.json command, run by Git Bash with CLAUDE_PLUGIN_ROOT in $f, from a path with a space, prompts for a write" {
      if (-not $script:GitBash) { return (Skip 'no Git Bash') }
      $rootValue = if ($f -eq 'backslashes') { $Spaced } else { $Spaced -replace '\\', '/' }
      $env1 = @{ CLAUDE_PLUGIN_ROOT = $rootValue; PLUGIN_ROOT = $null; BONEZ_MCP_GATE_DISABLE = $null }
      $w = Invoke-Native $script:GitBash @('-c', $gateCommand) -InputText $claudeWrite -EnvVars $env1
      if ($w.ExitCode -ne 0) { return (Fail "exit $($w.ExitCode) (a hook must exit 0):`n$(Show-Text $w.Err 6)") }
      if ($w.Out -notmatch '"permissionDecision":"ask"') { return (Fail "no ask decision for a graph_write.`ncommand: $gateCommand`nCLAUDE_PLUGIN_ROOT=$rootValue`nstdout: '$($w.Out)'`nstderr: $(Show-Text $w.Err 6)") }
      $r = Invoke-Native $script:GitBash @('-c', $gateCommand) -InputText $claudeRead -EnvVars $env1
      if ($r.ExitCode -ne 0 -or $r.Out.Trim() -ne '') { return (Fail "a read must pass through silently; exit $($r.ExitCode), stdout '$($r.Out)'") }
      return (Pass ("write: " + $w.Out.Trim() + "`nread: (silent)"))
    }
  }

  Check 'Cursor hook: `bash ./hooks/gate-write.sh` run from the plugin folder through cmd.exe prompts for a write' {
    $payload = '{"hook_event_name":"beforeMCPExecution","tool_name":"graph_write","tool_input":"{\"op\":\"remember\"}","mcp_server_name":"bonez","url":"https://bonez.example.com/mcp"}'
    $cursorCommand = ((Get-Content -Raw -Encoding UTF8 -LiteralPath (P $Root @('cursor', 'hooks', 'hooks.json')) | ConvertFrom-Json).hooks.beforeMCPExecution[0].command)
    $r = Invoke-Native 'cmd.exe' @('/c', $cursorCommand) -InputText $payload -WorkDir (P $Spaced @('cursor')) -EnvVars @{ CLAUDE_PLUGIN_ROOT = $null; PLUGIN_ROOT = $null; BONEZ_MCP_GATE_DISABLE = $null }
    if ($r.Out -notmatch '"permission":"ask"') {
      return (Fail "no ask decision (Cursor would let the write through).`ncommand: $cursorCommand`nexit $($r.ExitCode), stdout '$($r.Out)', stderr: $(Show-Text $r.Err 4)")
    }
    return (Pass ($r.Out.Trim().Substring(0, [Math]::Min(120, $r.Out.Trim().Length)) + '...'))
  }

  # ---- session capture's entry point ----------------------------------------------------------------

  Check 'bonez-session-sync.mjs runs when started from a path with a space (its main() guard used to be false on Windows)' {
    if (-not $Node) { return (Skip 'no node') }
    $home1 = P $Tmp @('home')
    New-Item -ItemType Directory -Force -Path $home1 | Out-Null
    $r = Invoke-Native $Node @((P $Spaced @('bin', 'bonez-session-sync.mjs')), 'status') -EnvVars @{ HOME = $home1; USERPROFILE = $home1; BONEZ_SESSION_SYNC_DATA = (P $home1 @('data')); BONEZ_SESSION_SYNC = $null }
    if ($r.Out -notmatch 'session capture: not installed') { return (Fail "main() did not run; exit $($r.ExitCode), stdout '$($r.Out.Trim())', stderr '$($r.Err.Trim())'") }
    return (Pass (Show-Text $r.Out 1))
  }

  # ---- the repo's own node tests --------------------------------------------------------------------

  Check "the repo's node tests (tree hash vectors, push CLI, Windows paths, line endings, hash and push suites)" {
    if (-not $Node) { return (Skip 'no node') }
    $files = @('plugin_tree.test.mjs', 'windows_portability.test.mjs', 'package_hash.test.mjs', 'plugin_push.test.mjs') | ForEach-Object { P $Root @('tests', $_) }
    $r = Invoke-Native $Node (@('--test') + $files) -TimeoutSec 600
    $summary = (($r.Out -split "`n") | Where-Object { $_ -match '^\S*\s*(tests|pass|fail|skipped) ' -or $_ -match '^# (tests|pass|fail|skipped)' } | ForEach-Object { $_.Trim() }) -join '; '
    if ($r.ExitCode -ne 0) {
      $tail = @(($r.Out + $r.Err) -split "`n") | Select-Object -Last 40
      return (Fail ("exit $($r.ExitCode); $summary`n" + ($tail -join "`n")))
    }
    return (Pass $summary)
  }
}
finally {
  Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host ("windows-client-checks: {0} passed, {1} failed, {2} skipped" -f $script:Pass, $script:Fail, $script:Skip)
if ($script:Fail -gt 0) { exit 1 }
exit 0
