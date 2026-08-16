[CmdletBinding()]
param(
    [string]$BuildDirectory,
    [string]$Sdkconfig
)

if ([string]::IsNullOrWhiteSpace($BuildDirectory) -xor [string]::IsNullOrWhiteSpace($Sdkconfig)) {
    throw 'BuildDirectory and Sdkconfig must be supplied together for an isolated build.'
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

Initialize-Tab5IdfEnvironment
Set-Tab5FirmwareLocation

$idfArguments = @()
if (-not [string]::IsNullOrWhiteSpace($BuildDirectory)) {
    $resolvedBuildDirectory = Resolve-Tab5ProjectPath -Path $BuildDirectory -Label 'BuildDirectory'
    $resolvedSdkconfig = Resolve-Tab5ProjectPath -Path $Sdkconfig -Label 'Sdkconfig'
    $idfArguments += @('-B', $resolvedBuildDirectory, '-D', "SDKCONFIG=$resolvedSdkconfig")
}

Invoke-Tab5Idf -IdfArguments @($idfArguments + 'build')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Invoke-Tab5Idf -IdfArguments @($idfArguments + 'size')
exit $LASTEXITCODE
