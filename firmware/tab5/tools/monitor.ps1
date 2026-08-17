[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^COM\d+$')]
    [string]$Port,
    [string]$BuildDirectory,
    [string]$Sdkconfig,
    [switch]$NoReset,
    [switch]$Mock
)

if ([string]::IsNullOrWhiteSpace($BuildDirectory) -xor [string]::IsNullOrWhiteSpace($Sdkconfig)) {
    throw 'BuildDirectory and Sdkconfig must be supplied together for an isolated monitor.'
}

. (Join-Path $PSScriptRoot 'common.ps1')

function Resolve-Tab5ProjectPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $firmwareRoot = [System.IO.Path]::GetFullPath($script:FirmwareRoot).TrimEnd('\')
    $candidate = if ([System.IO.Path]::IsPathRooted($Path)) {
        [System.IO.Path]::GetFullPath($Path)
    } else {
        [System.IO.Path]::GetFullPath((Join-Path $firmwareRoot $Path))
    }
    if (-not $candidate.StartsWith("$firmwareRoot\", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label must be inside $firmwareRoot."
    }
    return $candidate
}

$idfArguments = @()
if (-not [string]::IsNullOrWhiteSpace($BuildDirectory)) {
    $resolvedBuildDirectory = Resolve-Tab5ProjectPath -Path $BuildDirectory -Label 'BuildDirectory'
    $resolvedSdkconfig = Resolve-Tab5ProjectPath -Path $Sdkconfig -Label 'Sdkconfig'
    $idfArguments += @('-B', $resolvedBuildDirectory, '-D', "SDKCONFIG=$resolvedSdkconfig")
}
$idfArguments += @('-p', $Port, 'monitor')
if ($NoReset) {
    $idfArguments += '--no-reset'
}

if ($Mock) {
    Write-Host 'Mock idf.py literal arguments:'
    $idfArguments | ForEach-Object { Write-Host "[$_]" }
    return
}

Initialize-Tab5IdfEnvironment
Set-Tab5FirmwareLocation
Invoke-Tab5Idf -IdfArguments $idfArguments
exit $LASTEXITCODE
