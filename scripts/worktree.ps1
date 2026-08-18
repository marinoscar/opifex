<#
.SYNOPSIS
  Git worktree helper:
    - Creates a new worktree + branch using an OpenAI LLM to name things
    - Lists existing worktrees
    - Removes a worktree (optionally force)
    - Shows help/usage

.DESCRIPTION
  Default behavior (no -List / -Remove / -Help):
    1) Prompts for a natural language description of the feature
    2) Calls OpenAI (model: gpt-5-nano) to generate:
         { "branch_slug": "...", "folder_name": "..." }
    3) Creates a branch (prefix default: feature/)
    4) Creates a worktree at: <root>/worktrees/<folder_name>
    5) CD into the new worktree (unless -NoCd)

  List behavior (-List):
    - Prints a table of all worktrees for the current repo using:
        git worktree list --porcelain

  Remove behavior (-Remove <nameOrPath>):
    - Removes a worktree by folder name under <root>/worktrees OR full path
    - Uses:
        git worktree remove <path>  (or --force)
    - NOTE: If you are currently inside that folder, Windows may block deletion.
            cd elsewhere first.

  Help behavior (-Help):
    - Prints usage examples and exits.

.REQUIREMENTS
  - Git installed and on PATH
  - Run from inside a git repository working tree
  - For create mode: OPENAI_API_KEY env var, or you will be prompted

.NOTES
  Place this script at: root/scripts/worktrees.ps1
  Worktrees will be created under: root/worktrees
#>

[CmdletBinding()]
param(
  # Prefix for your feature branches (e.g. feature/, bugfix/, chore/)
  [string]$BranchPrefix = "feature/",

  # Worktrees root. If not provided, defaults to "<root>/worktrees" based on script location.
  [string]$WorktreesRoot = "",

  # Max length for folder name (LLM is asked to keep it short; we enforce it too)
  [int]$MaxFolderNameLength = 40,

  # If set, do NOT cd into the created folder
  [switch]$NoCd,

  # List all worktrees and exit
  [switch]$List,

  # Remove a worktree by folder name (under WorktreesRoot) or full path, then exit
  [string]$Remove,

  # Force removal for worktree remove
  [switch]$Force,

  # Show help/usage and exit
  [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ----------------------------
# Config
# ----------------------------
$OpenAiModel = "gpt-5-nano"
$OpenAiEndpoint = "https://api.openai.com/v1/responses"

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Info { param([string]$Message) Write-Host "    $Message" -ForegroundColor Gray }
function Write-Warn { param([string]$Message) Write-Host "WARNING: $Message" -ForegroundColor Yellow }
function Write-Fail { param([string]$Message) Write-Host "ERROR: $Message" -ForegroundColor Red }

function Show-Help {
  Write-Host ""
  Write-Host "Git Worktree Helper (LLM-named) - Usage" -ForegroundColor Cyan
  Write-Host "--------------------------------------"
  Write-Host ""
  Write-Host "Create a new worktree (default):" -ForegroundColor White
  Write-Host "  .\root\scripts\worktrees.ps1"
  Write-Host ""
  Write-Host "List worktrees:" -ForegroundColor White
  Write-Host "  .\root\scripts\worktrees.ps1 -List"
  Write-Host ""
  Write-Host "Remove a worktree by folder name (under root/worktrees):" -ForegroundColor White
  Write-Host "  .\root\scripts\worktrees.ps1 -Remove update-db"
  Write-Host ""
  Write-Host "Remove a worktree by full path:" -ForegroundColor White
  Write-Host '  .\root\scripts\worktrees.ps1 -Remove "C:\path\to\root\worktrees\update-db"'
  Write-Host ""
  Write-Host "Force remove (if needed):" -ForegroundColor White
  Write-Host "  .\root\scripts\worktrees.ps1 -Remove update-db -Force"
  Write-Host ""
  Write-Host "Don't cd into newly created worktree:" -ForegroundColor White
  Write-Host "  .\root\scripts\worktrees.ps1 -NoCd"
  Write-Host ""
  Write-Host "Show this help:" -ForegroundColor White
  Write-Host "  .\root\scripts\worktrees.ps1 -Help"
  Write-Host ""
  Write-Host "Notes:" -ForegroundColor White
  Write-Host "  - Worktrees are created under: root/worktrees (relative to script location)."
  Write-Host "  - For create mode, OpenAI key is read from OPENAI_API_KEY; if missing you will be prompted."
  Write-Host "  - If you are currently inside a worktree folder you want to remove, Windows may block deletion."
  Write-Host ""
}

function Test-Command {
  param([Parameter(Mandatory)][string]$Name)
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-Git {
  <#
    .SYNOPSIS
      Runs git with arguments, echoes the command, and throws if it fails.
  #>
  param(
    [Parameter(Mandatory)][string[]]$Args,
    [string]$WorkingDirectory = ""
  )

  $pretty = "git " + ($Args -join " ")
  Write-Info $pretty

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "git"
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError  = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  if ($WorkingDirectory -and (Test-Path $WorkingDirectory)) { $psi.WorkingDirectory = $WorkingDirectory }
  foreach ($a in $Args) { [void]$psi.ArgumentList.Add($a) }

  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi

  [void]$p.Start()
  $stdout = $p.StandardOutput.ReadToEnd()
  $stderr = $p.StandardError.ReadToEnd()
  $p.WaitForExit()

  if ($stdout) { Write-Host $stdout.TrimEnd() }
  if ($p.ExitCode -ne 0) {
    if ($stderr) { Write-Host $stderr.TrimEnd() -ForegroundColor DarkRed }
    throw "Git command failed (exit code $($p.ExitCode)): $pretty"
  }

  return $stdout
}

function Get-RepoRoot {
  $out = Invoke-Git -Args @("rev-parse","--show-toplevel")
  $root = $out.Trim()
  if (-not (Test-Path $root)) { throw "Repo root not found or not accessible: $root" }
  return $root
}

function Ensure-CleanOrWarn {
  param([Parameter(Mandatory)][string]$RepoRootPath)

  $status = Invoke-Git -Args @("status","--porcelain") -WorkingDirectory $RepoRootPath
  if (-not [string]::IsNullOrWhiteSpace($status)) {
    Write-Warn "You have uncommitted changes in the current working tree. Worktrees are fine, but be mindful."
  }
}

function ConvertTo-PlainTextFromSecureString {
  param([Parameter(Mandatory)][Security.SecureString]$Secure)
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Get-OpenAiApiKey {
  $apiKey = $env:OPENAI_API_KEY
  if (-not [string]::IsNullOrWhiteSpace($apiKey)) {
    return $apiKey
  }

  Write-Warn "OPENAI_API_KEY is not set."
  Write-Info "You can paste it now (it will be hidden)."

  $secure = Read-Host "Enter OpenAI API Key" -AsSecureString
  $apiKey = ConvertTo-PlainTextFromSecureString -Secure $secure

  if ([string]::IsNullOrWhiteSpace($apiKey)) {
    throw "No API key provided. Cannot continue because LLM naming is required."
  }

  $env:OPENAI_API_KEY = $apiKey

  $persist = Read-Host "Persist OPENAI_API_KEY for future sessions? (y/N)"
  if ($persist -match '^(y|yes)$') {
    Write-Info "Persisting OPENAI_API_KEY in user environment variables..."
    [Environment]::SetEnvironmentVariable("OPENAI_API_KEY", $apiKey, "User")
    Write-Info "Done. You may need a new terminal session for it to be available everywhere."
  } else {
    Write-Info "API key will be used for this session only."
  }

  return $apiKey
}

function Assert-SafeName {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$FieldName
  )

  if ([string]::IsNullOrWhiteSpace($Name)) {
    throw "$FieldName is empty."
  }

  if ($Name -notmatch '^[a-z0-9]+(-[a-z0-9]+)*$') {
    throw "$FieldName contains invalid characters: '$Name' (allowed: a-z, 0-9, hyphen; cannot start/end with hyphen)."
  }
}

function Truncate-Name {
  param(
    [Parameter(Mandatory)][string]$Text,
    [Parameter(Mandatory)][int]$MaxLength
  )

  if ($Text.Length -le $MaxLength) { return $Text }

  $hash = [Math]::Abs($Text.GetHashCode()).ToString()
  $suffix = "-" + $hash.Substring(0, [Math]::Min(6, $hash.Length))

  $keep = $MaxLength - $suffix.Length
  if ($keep -lt 5) { return $Text.Substring(0, $MaxLength) }

  return ($Text.Substring(0, $keep) + $suffix)
}

function Get-WorktreesPorcelain {
  param([Parameter(Mandatory)][string]$RepoRootPath)

  $out = Invoke-Git -Args @("worktree","list","--porcelain") -WorkingDirectory $RepoRootPath
  $lines = $out -split "`r?`n"

  $items = @()
  $current = @{}

  foreach ($line in $lines) {
    if ([string]::IsNullOrWhiteSpace($line)) {
      if ($current.ContainsKey("worktree")) {
        $items += [PSCustomObject]@{
          Path     = $current["worktree"]
          Head     = $current["HEAD"]
          Branch   = $current["branch"]
          Locked   = $current.ContainsKey("locked")
          Prunable = $current.ContainsKey("prunable")
        }
      }
      $current = @{}
      continue
    }

    $parts = $line.Split(" ", 2)
    $key = $parts[0]
    $val = if ($parts.Count -gt 1) { $parts[1] } else { "" }
    $current[$key] = $val
  }

  if ($current.ContainsKey("worktree")) {
    $items += [PSCustomObject]@{
      Path     = $current["worktree"]
      Head     = $current["HEAD"]
      Branch   = $current["branch"]
      Locked   = $current.ContainsKey("locked")
      Prunable = $current.ContainsKey("prunable")
    }
  }

  return $items
}

function Resolve-WorktreePath {
  param(
    [Parameter(Mandatory)][string]$WorktreesRootPath,
    [Parameter(Mandatory)][string]$NameOrPath
  )

  if (Test-Path $NameOrPath) {
    return (Resolve-Path $NameOrPath).Path
  }

  $candidate = Join-Path $WorktreesRootPath $NameOrPath
  if (Test-Path $candidate) {
    return (Resolve-Path $candidate).Path
  }

  throw "Could not resolve worktree '$NameOrPath' as a path or as a folder under: $WorktreesRootPath"
}

function Get-LlmWorktreeSuggestion {
  param(
    [Parameter(Mandatory)][string]$NaturalLanguage,
    [Parameter(Mandatory)][string]$ApiKey,
    [Parameter(Mandatory)][string]$Model
  )

  $prompt = @"
You generate git/worktree naming.

Return STRICT JSON ONLY with:
{
  "branch_slug": "lowercase-hyphen-slug",
  "folder_name": "short-lowercase-hyphen-name"
}

Rules:
- Use ONLY a-z, 0-9, and hyphen.
- branch_slug: descriptive but concise (<= 60 chars).
- folder_name: shorter (<= 30 chars), still meaningful.
- Do not include customer names, secrets, ticket numbers, or personal data.
- No markdown, no extra text, JSON only.

User request: "$NaturalLanguage"
"@

  $bodyObj = @{
    model = $Model
    input = @(
      @{
        role = "user"
        content = @(
          @{ type = "input_text"; text = $prompt }
        )
      }
    )
    text = @{
      format = @{ type = "json_object" }
    }
  }

  $body = $bodyObj | ConvertTo-Json -Depth 10

  Write-Step "Calling OpenAI for naming (model: $Model)"
  Write-Info "Endpoint: $OpenAiEndpoint"

  $resp = $null
  try {
    $resp = Invoke-RestMethod -Method Post -Uri $OpenAiEndpoint -Headers @{
      Authorization = "Bearer $ApiKey"
      "Content-Type" = "application/json"
    } -Body $body
  }
  catch {
    throw "OpenAI call failed: $($_.Exception.Message)"
  }

  $text = $null
  if ($resp -and $resp.output) {
    foreach ($o in $resp.output) {
      if ($o.content) {
        foreach ($c in $o.content) {
          if ($c.type -eq "output_text" -and $c.text) { $text = $c.text }
        }
      }
    }
  }

  if ([string]::IsNullOrWhiteSpace($text)) {
    throw "OpenAI returned no usable output text."
  }

  $json = $null
  try {
    $json = $text | ConvertFrom-Json
  }
  catch {
    throw "Failed to parse OpenAI output as JSON. Raw output: $text"
  }

  $branchSlug = [string]$json.branch_slug
  $folderName = [string]$json.folder_name

  Assert-SafeName -Name $branchSlug -FieldName "branch_slug"
  Assert-SafeName -Name $folderName -FieldName "folder_name"

  return [PSCustomObject]@{
    BranchSlug = $branchSlug
    FolderName = $folderName
  }
}

try {
  # Help is purely local — do it first (no git required)
  if ($Help) {
    Show-Help
    exit 0
  }

  Write-Step "Validating environment"

  if (-not (Test-Command "git")) { throw "Git is not installed or not on PATH." }

  # Must be run inside a git repo work tree
  $null = Invoke-Git -Args @("rev-parse","--is-inside-work-tree") | Out-Null

  $repoRoot = Get-RepoRoot
  Write-Info "Repo root: $repoRoot"

  Ensure-CleanOrWarn -RepoRootPath $repoRoot

  # Determine root folder based on script path:
  #   root/scripts/worktrees.ps1 => RootDir = root
  $scriptPath = $PSCommandPath
  if (-not $scriptPath) { throw "Unable to determine script path (PSCommandPath is empty)." }

  $scriptsDir = Split-Path -Parent $scriptPath
  $rootDir    = Split-Path -Parent $scriptsDir

  Write-Info "Script path: $scriptPath"
  Write-Info "Root dir:    $rootDir"

  # WorktreesRoot defaults to <root>/worktrees
  if ([string]::IsNullOrWhiteSpace($WorktreesRoot)) {
    $WorktreesRoot = Join-Path $rootDir "worktrees"
  }
  Write-Info "Worktrees root: $WorktreesRoot"

  if (-not (Test-Path $WorktreesRoot)) {
    Write-Step "Creating worktrees root folder"
    Write-Info "mkdir $WorktreesRoot"
    New-Item -ItemType Directory -Path $WorktreesRoot | Out-Null
  }

  # -------------------------
  # -List mode
  # -------------------------
  if ($List) {
    Write-Step "Listing worktrees"
    $wts = Get-WorktreesPorcelain -RepoRootPath $repoRoot

    if (-not $wts -or $wts.Count -eq 0) {
      Write-Info "No worktrees found."
      exit 0
    }

    $wts |
      Select-Object @{
        Name="Path"; Expression={$_.Path}
      }, @{
        Name="Branch"; Expression={
          if ($_.Branch) { $_.Branch -replace '^refs/heads/','' } else { "" }
        }
      }, @{
        Name="HEAD"; Expression={$_.Head}
      }, @{
        Name="Locked"; Expression={$_.Locked}
      } |
      Format-Table -AutoSize

    exit 0
  }

  # -------------------------
  # -Remove mode
  # -------------------------
  if (-not [string]::IsNullOrWhiteSpace($Remove)) {
    Write-Step "Removing worktree"

    $targetPath = Resolve-WorktreePath -WorktreesRootPath $WorktreesRoot -NameOrPath $Remove
    Write-Info "Target worktree path: $targetPath"

    $wts = Get-WorktreesPorcelain -RepoRootPath $repoRoot
    $wt = $wts | Where-Object { $_.Path -eq $targetPath } | Select-Object -First 1

    if (-not $wt) {
      throw "No registered worktree found at: $targetPath"
    }

    # Safety: do not remove the main worktree (repo root)
    $repoRootResolved = (Resolve-Path $repoRoot).Path
    if ($targetPath -eq $repoRootResolved) {
      throw "Refusing to remove the main working tree (repo root): $repoRootResolved"
    }

    $removeArgs = @("worktree","remove")
    if ($Force) { $removeArgs += "--force" }
    $removeArgs += $targetPath

    Write-Step "Running git worktree remove"
    Invoke-Git -Args $removeArgs -WorkingDirectory $repoRoot | Out-Null

    Write-Step "Worktree removed"
    Write-Step "Done"
    exit 0
  }

  # -------------------------
  # Create mode (default)
  # -------------------------

  # Ensure we have an API key (LLM naming is required for create mode)
  $apiKey = Get-OpenAiApiKey

  Write-Step "Gathering feature intent (natural language)"
  $featureRaw = Read-Host "Describe the feature (natural language)"
  if ([string]::IsNullOrWhiteSpace($featureRaw)) { throw "Input cannot be empty." }

  $suggestion = Get-LlmWorktreeSuggestion -NaturalLanguage $featureRaw -ApiKey $apiKey -Model $OpenAiModel

  # Enforce folder length even if model gives longer
  $folderName = Truncate-Name -Text $suggestion.FolderName -MaxLength $MaxFolderNameLength
  $slug = $suggestion.BranchSlug

  $branchName = "$BranchPrefix$slug"
  $worktreePath = Join-Path $WorktreesRoot $folderName

  Write-Step "Plan (from LLM)"
  Write-Info "Request:       $featureRaw"
  Write-Info "Model:         $OpenAiModel"
  Write-Info "Branch:        $branchName"
  Write-Info "Folder:        $folderName"
  Write-Info "Worktree path: $worktreePath"

  if (Test-Path $worktreePath) { throw "Worktree folder already exists: $worktreePath" }

  Write-Step "Checking branch existence"
  $branchExists = $false
  try {
    Invoke-Git -Args @("show-ref","--verify","--quiet","refs/heads/$branchName") -WorkingDirectory $repoRoot | Out-Null
    $branchExists = $true
  } catch {
    # Not found is expected; ignore
  }
  if ($branchExists) { throw "Branch already exists locally: $branchName" }

  Write-Step "Creating worktree and branch"
  Invoke-Git -Args @("worktree","add","-b",$branchName,$worktreePath) -WorkingDirectory $repoRoot | Out-Null

  Write-Step "Worktree created successfully"
  Write-Info "New worktree: $worktreePath"
  Write-Info "Branch:       $branchName"

  Write-Step "Current worktrees"
  Invoke-Git -Args @("worktree","list") -WorkingDirectory $repoRoot | Out-Null

  if (-not $NoCd) {
    Write-Step "Changing directory to new worktree"
    Set-Location -Path $worktreePath
    Write-Info "Now in: $(Get-Location)"
  } else {
    Write-Info "NoCd specified; staying in current directory."
  }

  Write-Step "Done"
}
catch {
  Write-Fail $_.Exception.Message
  Write-Info "Tip: run -Help for usage:"
  Write-Info "  .\root\scripts\worktrees.ps1 -Help"
  exit 1
}