<#
.SYNOPSIS
    Publishes this project to GitHub as a new repository.

.DESCRIPTION
    Creates a local git repository (if needed), commits everything, creates the GitHub
    repository and pushes to it.

    Safe to re-run: it commits any new changes and pushes again.

    Requires:
      * git           https://git-scm.com/download/win
      * GitHub CLI    https://cli.github.com/   (then run: gh auth login)
    If the GitHub CLI is missing, the script still prepares and commits the repository and
    then prints the exact commands to finish the job by hand.

.EXAMPLE
    .\publish-to-github.ps1
    Publishes as Remote-Screen-and-file-sharing-App, public.

.EXAMPLE
    .\publish-to-github.ps1 -Visibility private
    Same, but a private repository.

.EXAMPLE
    .\publish-to-github.ps1 -RepoName peerlink -Visibility public
    Uses a different repository name.
#>

[CmdletBinding()]
param(
    # GitHub repository names cannot contain spaces, so the requested name
    # "Remote Screen and file sharing App" becomes hyphenated.
    [string] $RepoName = 'Remote-Screen-and-file-sharing-App',

    [ValidateSet('public', 'private')]
    [string] $Visibility = 'public',

    [string] $Description = 'Minimal remote desktop and file sharing for Windows: screen sharing, remote control and unlimited-size peer-to-peer file transfer. English and Romanian.',

    [string] $CommitMessage = 'Initial commit: PeerLink 1.0.0'
)

$ErrorActionPreference = 'Stop'

function Write-Step   ([string] $Text) { Write-Host "`n==> $Text" -ForegroundColor Cyan }
function Write-Ok     ([string] $Text) { Write-Host "    $Text" -ForegroundColor Green }
function Write-Warn2  ([string] $Text) { Write-Host "    $Text" -ForegroundColor Yellow }
function Write-Fail   ([string] $Text) { Write-Host "    $Text" -ForegroundColor Red }

# Work from the folder this script lives in, not the caller's current directory.
Set-Location -LiteralPath $PSScriptRoot

Write-Host ''
Write-Host '  PeerLink - publish to GitHub' -ForegroundColor White
Write-Host '  ============================' -ForegroundColor White

# ---------------------------------------------------------------------------- preflight
Write-Step 'Checking requirements'

$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
    Write-Fail 'git was not found. Install it from https://git-scm.com/download/win and re-run.'
    exit 1
}
Write-Ok "git $((& git --version) -replace '^git version ', '')"

$gh = Get-Command gh -ErrorAction SilentlyContinue
$ghReady = $false
if ($gh) {
    & gh auth status *> $null
    if ($LASTEXITCODE -eq 0) {
        $ghReady = $true
        Write-Ok 'GitHub CLI is installed and authenticated'
    } else {
        Write-Warn2 'GitHub CLI is installed but not authenticated - run "gh auth login" to publish automatically'
    }
} else {
    Write-Warn2 'GitHub CLI not found - the repository will be prepared and committed, then you finish with two commands'
}

# ------------------------------------------------------------------------- local repo
Write-Step 'Preparing the local repository'

if (-not (Test-Path -LiteralPath '.git')) {
    & git init | Out-Null
    Write-Ok 'Created a new git repository'
} else {
    Write-Ok 'Using the existing git repository'
}

# Use "main" as the default branch.
& git symbolic-ref --short HEAD *> $null
if ($LASTEXITCODE -ne 0) {
    & git checkout -b main *> $null
} elseif ((& git symbolic-ref --short HEAD) -ne 'main') {
    & git branch -M main | Out-Null
    Write-Ok 'Renamed the current branch to main'
}

# A commit needs an identity. Prefer the global one; otherwise ask, and store it on this
# repository only so the machine-wide config is left alone.
$userName = & git config user.name
$userEmail = & git config user.email
if (-not $userName -or -not $userEmail) {
    Write-Warn2 'git has no name/email configured, which is required for a commit.'
    $name = Read-Host '    Your name for commits (e.g. Ion Popescu)'
    $email = Read-Host '    Your email for commits (e.g. you@example.com)'
    if (-not $name -or -not $email) {
        Write-Fail 'Both are required. Nothing was committed.'
        exit 1
    }
    & git config user.name $name
    & git config user.email $email
    Write-Ok "Saved for this repository only: $name <$email>"
} else {
    Write-Ok "Committing as $userName <$userEmail>"
}

# ----------------------------------------------------------------------------- commit
Write-Step 'Staging and committing'

& git add -A
if ($LASTEXITCODE -ne 0) { Write-Fail 'git add failed.'; exit 1 }

& git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
    Write-Ok 'Nothing new to commit'
} else {
    & git commit -m $CommitMessage | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Fail 'git commit failed.'; exit 1 }
    $count = (& git rev-list --count HEAD)
    Write-Ok "Committed ($count commit(s) on main)"
}

Write-Host ''
Write-Host '    Files that will be published:' -ForegroundColor Gray
& git ls-files | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }

# --------------------------------------------------------------------------- github
if (-not $ghReady) {
    Write-Step 'Next: create the repository on GitHub'
    Write-Host ''
    Write-Host '  1. Open https://github.com/new' -ForegroundColor White
    Write-Host "     Name it:  $RepoName" -ForegroundColor White
    Write-Host "     Visibility: $Visibility     Do NOT add a README or .gitignore" -ForegroundColor White
    Write-Host ''
    Write-Host '  2. Then run these two commands here:' -ForegroundColor White
    Write-Host ''
    Write-Host '       git remote add origin https://github.com/<your-username>/' -NoNewline -ForegroundColor Yellow
    Write-Host $RepoName -ForegroundColor Yellow
    Write-Host '       git push -u origin main' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  Or install the GitHub CLI (https://cli.github.com), run "gh auth login",' -ForegroundColor Gray
    Write-Host '  and re-run this script to have it done automatically.' -ForegroundColor Gray
    Write-Host ''
    exit 0
}

Write-Step 'Creating the GitHub repository and pushing'

$existingRemote = & git remote get-url origin 2>$null
if ($existingRemote) {
    Write-Ok "origin already points at $existingRemote"
    & git push -u origin main
    if ($LASTEXITCODE -ne 0) { Write-Fail 'git push failed.'; exit 1 }
} else {
    # --source . uses this folder, --push sends the commit we just made.
    & gh repo create $RepoName "--$Visibility" --source . --remote origin --push --description $Description
    if ($LASTEXITCODE -ne 0) {
        Write-Fail 'gh repo create failed.'
        Write-Warn2 'If the name is already taken, re-run with a different one:'
        Write-Warn2 "    .\publish-to-github.ps1 -RepoName $RepoName-2"
        exit 1
    }
}

$login = & gh api user --jq '.login' 2>$null
Write-Host ''
Write-Host "  Published: https://github.com/$login/$RepoName" -ForegroundColor Green
Write-Host ''
