[CmdletBinding()]
param(
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$ExpectedPilotSha,
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$ExpectedRecoverySha = '844e398ac394a5772d68097622df979f2e55a1bb'
)

. (Join-Path $PSScriptRoot 'common.ps1')

$callerLocation = (Get-Location).Path
Set-Location -LiteralPath $script:RepoRoot
$branch = git branch --show-current
$head = git rev-parse HEAD
$trackedWorktreeDirty = (git diff --name-only)
$trackedIndexDirty = (git diff --cached --name-only)
$untracked = git ls-files --others --exclude-standard
Write-Host "Branch: $branch"
Write-Host "HEAD: $head"
if ([string]::IsNullOrWhiteSpace($trackedWorktreeDirty) -and [string]::IsNullOrWhiteSpace($trackedIndexDirty)) {
    Write-Host 'Tracked worktree: clean'
} else {
    Write-Error "Tracked worktree is dirty:`n$trackedWorktreeDirty`n$trackedIndexDirty"
    exit 1
}
Write-Host "Untracked paths (preserved): $(@($untracked).Count)"

git fetch origin --prune
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$advertised = git ls-remote origin refs/heads/pilot
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($advertised)) {
    Write-Error 'Could not read the advertised pilot ref.'
    exit 1
}
$pilotSha = ($advertised -split "`t")[0]
Write-Host "Advertised pilot: $pilotSha"
if ($ExpectedPilotSha -and $pilotSha -ne $ExpectedPilotSha) {
    Write-Error "Advertised pilot does not match expected SHA: $ExpectedPilotSha"
    exit 1
}

$recoveryAdvertised = git ls-remote origin refs/heads/agent/tab5-known-good-rebuild
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($recoveryAdvertised)) {
    Write-Error 'Could not read the advertised recovery ref.'
    exit 1
}
$recoverySha = ($recoveryAdvertised -split "`t")[0]
Write-Host "Advertised recovery: $recoverySha"
if ($ExpectedRecoverySha -and $recoverySha -ne $ExpectedRecoverySha) {
    Write-Error "Advertised recovery does not match expected SHA: $ExpectedRecoverySha"
    exit 1
}

git check-ignore -q -- firmware/tab5/main/secrets.local.h
if ($LASTEXITCODE -ne 0) {
    Write-Error 'firmware/tab5/main/secrets.local.h is not ignored.'
    exit 1
}
Write-Host 'Secrets path: ignored'

Initialize-Tab5IdfEnvironment
Write-Host "ESP-IDF: $(Invoke-Tab5Idf -IdfArguments @('--version'))"
Write-Host "Python: $((Get-Command python).Source)"
Set-Location -LiteralPath $callerLocation
