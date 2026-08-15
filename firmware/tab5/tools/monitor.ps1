[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^COM\d+$')]
    [string]$Port
)

. (Join-Path $PSScriptRoot 'common.ps1')
Initialize-Tab5IdfEnvironment
Set-Tab5FirmwareLocation
Invoke-Tab5Idf -p $Port monitor
exit $LASTEXITCODE
