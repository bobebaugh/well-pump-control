[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^COM\d+$')]
    [string]$Port
)

. (Join-Path $PSScriptRoot 'common.ps1')
Set-Location -LiteralPath $script:RepoRoot
Write-Host "Source commit: $(git rev-parse HEAD)"
$status = git status --porcelain=v1
Write-Host $(if ([string]::IsNullOrWhiteSpace($status)) { 'Worktree: clean' } else { "Worktree: dirty`n$status" })

if (-not (Get-CimInstance Win32_SerialPort | Where-Object { $_.DeviceID -eq $Port })) {
    throw "Requested serial port is not present: $Port"
}
Initialize-Tab5IdfEnvironment
Set-Tab5FirmwareLocation
Invoke-Tab5Idf -p $Port flash
exit $LASTEXITCODE
