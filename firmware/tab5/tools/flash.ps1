[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^COM\d+$')]
    [string]$Port,
    [string]$BuildDirectory,
    [string]$Sdkconfig,
    [switch]$Mock
)

if ([string]::IsNullOrWhiteSpace($BuildDirectory) -xor [string]::IsNullOrWhiteSpace($Sdkconfig)) {
    throw 'BuildDirectory and Sdkconfig must be supplied together for an isolated flash.'
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

Set-Location -LiteralPath $script:RepoRoot
Write-Host "Source commit: $(git rev-parse HEAD)"
$status = git status --porcelain=v1
if ([string]::IsNullOrWhiteSpace($status)) {
    Write-Host 'Worktree: clean'
} else {
    Write-Host "Worktree: dirty`n$status"
    throw 'Refusing to flash a dirty worktree.'
}

$selectedBuildDirectory = if ([string]::IsNullOrWhiteSpace($BuildDirectory)) { 'build' } else { $BuildDirectory }
$selectedSdkconfig = if ([string]::IsNullOrWhiteSpace($Sdkconfig)) { 'sdkconfig' } else { $Sdkconfig }
$resolvedBuildDirectory = Resolve-Tab5ProjectPath -Path $selectedBuildDirectory -Label 'BuildDirectory'
$resolvedSdkconfig = Resolve-Tab5ProjectPath -Path $selectedSdkconfig -Label 'Sdkconfig'
$applicationPath = Join-Path $resolvedBuildDirectory 'well_pump_tab5.bin'
$requiredMetadata = @(
    (Join-Path $resolvedBuildDirectory 'project_description.json'),
    (Join-Path $resolvedBuildDirectory 'flasher_args.json')
)

if (-not (Test-Path -LiteralPath $resolvedBuildDirectory -PathType Container)) {
    throw "Build directory is missing: $resolvedBuildDirectory"
}
if (-not (Test-Path -LiteralPath $resolvedSdkconfig -PathType Leaf)) {
    throw "SDK configuration is missing: $resolvedSdkconfig"
}
if (-not (Test-Path -LiteralPath $applicationPath -PathType Leaf)) {
    throw "Application binary is missing: $applicationPath"
}
foreach ($metadataPath in $requiredMetadata) {
    if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
        throw "Required build metadata is missing: $metadataPath"
    }
}

$application = Get-Item -LiteralPath $applicationPath
$applicationHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $applicationPath).Hash.ToLower()
Write-Host "Build directory: $resolvedBuildDirectory"
Write-Host "SDK configuration: $resolvedSdkconfig"
Write-Host "Application: $applicationPath"
Write-Host "Application size: $($application.Length) bytes"
Write-Host "Application SHA-256: $applicationHash"

$idfArguments = @()
if (-not [string]::IsNullOrWhiteSpace($BuildDirectory)) {
    $idfArguments += @('-B', $resolvedBuildDirectory, '-D', "SDKCONFIG=$resolvedSdkconfig")
}
$idfArguments += @('-p', $Port, 'flash')

if ($Mock) {
    Write-Host 'Mock idf.py literal arguments:'
    $idfArguments | ForEach-Object { Write-Host "[$_]" }
    return
}

if (-not (Get-CimInstance Win32_SerialPort | Where-Object { $_.DeviceID -eq $Port })) {
    throw "Requested serial port is not present: $Port"
}
Initialize-Tab5IdfEnvironment
Set-Tab5FirmwareLocation
Invoke-Tab5Idf -IdfArguments $idfArguments
exit $LASTEXITCODE
