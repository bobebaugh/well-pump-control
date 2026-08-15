[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot 'common.ps1')
Initialize-Tab5IdfEnvironment
Set-Tab5FirmwareLocation

Invoke-Tab5Idf build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Invoke-Tab5Idf size
exit $LASTEXITCODE
