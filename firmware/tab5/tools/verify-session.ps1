[CmdletBinding()]
param(
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$ExpectedPilotSha
)

. (Join-Path $PSScriptRoot 'common.ps1')

Set-Location -LiteralPath $script:RepoRoot
$branch = git branch --show-current
$head = git rev-parse HEAD
$status = git status --porcelain=v1
Write-Host "Branch: $branch"
Write-Host "HEAD: $head"
if ([string]::IsNullOrWhiteSpace($status)) {
    Write-Host 'Worktree: clean'
} else {
    Write-Error "Worktree is dirty:`n$status"
    exit 1
}

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

git check-ignore -q -- firmware/tab5/main/secrets.local.h
if ($LASTEXITCODE -ne 0) {
    Write-Error 'firmware/tab5/main/secrets.local.h is not ignored.'
    exit 1
}
Write-Host 'Secrets path: ignored'

Initialize-Tab5IdfEnvironment
Write-Host "ESP-IDF: $(Invoke-Tab5Idf -IdfArguments @('--version'))"
Write-Host "Python: $((Get-Command python).Source)"
