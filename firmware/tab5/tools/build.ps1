[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BuildDirectory,
    [Parameter(Mandatory = $true)]
    [string]$PackageDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

function Resolve-Tab5ProjectPath {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
    $firmwareRoot = [System.IO.Path]::GetFullPath($script:FirmwareRoot).TrimEnd('\')
    $candidate = if ([System.IO.Path]::IsPathRooted($Path)) { [System.IO.Path]::GetFullPath($Path) } else { [System.IO.Path]::GetFullPath((Join-Path $firmwareRoot $Path)) }
    if (-not $candidate.StartsWith("$firmwareRoot\", [System.StringComparison]::OrdinalIgnoreCase)) { throw "$Label must be inside $firmwareRoot." }
    return $candidate
}

function Get-RelativePackagePath {
    param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][string]$Path)
    return $Path.Substring($Root.TrimEnd('\').Length + 1).Replace('\', '/')
}

function Get-Sha256 { param([Parameter(Mandatory = $true)][string]$Path); return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

$buildRoot = Resolve-Tab5ProjectPath -Path $BuildDirectory -Label 'BuildDirectory'
$packageRoot = Resolve-Tab5ProjectPath -Path $PackageDirectory -Label 'PackageDirectory'
$configInput = Join-Path $script:FirmwareRoot 'config\sdkconfig.validation.defaults'
$generatedSdkconfig = Join-Path $buildRoot 'sdkconfig'
if (Test-Path -LiteralPath $buildRoot) { throw "Refusing to reuse or modify an existing build directory: $buildRoot" }
if (Test-Path -LiteralPath $packageRoot) { throw "Refusing to overwrite an existing checkpoint package: $packageRoot" }
if (-not (Test-Path -LiteralPath $configInput -PathType Leaf)) { throw "Tracked validation configuration is missing: $configInput" }

Set-Location -LiteralPath $script:RepoRoot
git diff --quiet
if ($LASTEXITCODE -ne 0) { throw 'Tracked worktree is not clean; refuse to produce a baseline receipt.' }
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { throw 'Tracked index is not clean; refuse to produce a baseline receipt.' }
$sourceSha = (git rev-parse HEAD).Trim()
$sourceBranch = (git branch --show-current).Trim()

Initialize-Tab5IdfEnvironment
New-Item -ItemType Directory -Path $buildRoot | Out-Null
$idfArguments = @('-B', $buildRoot, '-D', 'IDF_TARGET=esp32p4', '-D', "SDKCONFIG=$generatedSdkconfig", '-D', "SDKCONFIG_DEFAULTS=$configInput", 'build')
Set-Tab5FirmwareLocation
Invoke-Tab5Idf -IdfArguments $idfArguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Invoke-Tab5Idf -IdfArguments @('-B', $buildRoot, '-D', "SDKCONFIG=$generatedSdkconfig", 'size')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$requiredBuildFiles = @(
    'flash_args', 'flasher_args.json', 'bootloader\bootloader.bin', 'partition_table\partition-table.bin',
    'well_pump_tab5.bin', 'well_pump_tab5.elf', 'well_pump_tab5.map', 'sdkconfig'
)
foreach ($relative in $requiredBuildFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $buildRoot $relative) -PathType Leaf)) { throw "Required build output is missing: $relative" }
}

New-Item -ItemType Directory -Path $packageRoot | Out-Null
foreach ($relative in $requiredBuildFiles) {
    $destination = Join-Path $packageRoot $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath (Join-Path $buildRoot $relative) -Destination $destination
}
New-Item -ItemType Directory -Force -Path (Join-Path $packageRoot 'provenance') | Out-Null
Copy-Item -LiteralPath $configInput -Destination (Join-Path $packageRoot 'provenance\sdkconfig.validation.defaults')
Copy-Item -LiteralPath (Join-Path $script:FirmwareRoot 'dependencies.lock') -Destination (Join-Path $packageRoot 'provenance\dependencies.lock')
Get-ChildItem -LiteralPath (Join-Path $script:FirmwareRoot 'components') -Filter 'idf_component.yml' -Recurse | ForEach-Object {
    $destination = Join-Path $packageRoot (Join-Path 'provenance\components' (Get-RelativePackagePath -Root (Join-Path $script:FirmwareRoot 'components') -Path $_.FullName))
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $destination
}
Copy-Item -LiteralPath (Join-Path $script:FirmwareRoot 'main\idf_component.yml') -Destination (Join-Path $packageRoot 'provenance\main-idf_component.yml')

$flasherArgs = Get-Content -Raw -LiteralPath (Join-Path $buildRoot 'flasher_args.json') | ConvertFrom-Json
$flashMappings = @($flasherArgs.flash_files.PSObject.Properties | ForEach-Object { [pscustomobject]@{ offset = $_.Name; path = $_.Value } })
$idfVersion = (Invoke-Tab5Idf -IdfArguments @('--version') | Out-String).Trim()
$pythonVersion = (& $script:IdfPython --version 2>&1 | Out-String).Trim()
$receipt = @(
    '# Tab5 validation baseline build receipt',
    '',
    "Generated UTC: ``$(Get-Date -AsUTC -Format 'yyyy-MM-ddTHH:mm:ssZ')``",
    "Source branch: ``$sourceBranch``",
    "Source SHA: ``$sourceSha``",
    'Tracked worktree state: `clean`',
    "ESP-IDF path: ``$script:IdfPath``",
    "ESP-IDF version: ``$idfVersion``",
    "Python path: ``$script:IdfPython``",
    "Python version: ``$pythonVersion``",
    "Build command: ``idf.py $($idfArguments -join ' ')``",
    "Tracked configuration input: ``config/sdkconfig.validation.defaults`` SHA-256 ``$(Get-Sha256 $configInput)``",
    "Generated sdkconfig SHA-256: ``$(Get-Sha256 $generatedSdkconfig)``",
    "dependencies.lock SHA-256: ``$(Get-Sha256 (Join-Path $script:FirmwareRoot 'dependencies.lock'))``",
    'Resolved managed-component versions and hashes are preserved verbatim in `provenance/dependencies.lock`.',
    'Declared component constraints are preserved in `provenance/main-idf_component.yml`; local component manifests are under `provenance/components/`.',
    "Application binary: ``well_pump_tab5.bin`` bytes ``$((Get-Item -LiteralPath (Join-Path $buildRoot 'well_pump_tab5.bin')).Length)`` SHA-256 ``$(Get-Sha256 (Join-Path $buildRoot 'well_pump_tab5.bin'))``",
    "Application ELF: ``well_pump_tab5.elf`` bytes ``$((Get-Item -LiteralPath (Join-Path $buildRoot 'well_pump_tab5.elf')).Length)`` SHA-256 ``$(Get-Sha256 (Join-Path $buildRoot 'well_pump_tab5.elf'))``",
    '',
    'Flash mappings:',
    ($flashMappings | ForEach-Object { "- ``$($_.offset)`` → ``$($_.path)``" })
)
Set-Content -LiteralPath (Join-Path $packageRoot 'BUILD-RECEIPT.md') -Value $receipt -Encoding utf8

$artifacts = @(Get-ChildItem -LiteralPath $packageRoot -File -Recurse | ForEach-Object {
    [pscustomobject]@{ path = (Get-RelativePackagePath -Root $packageRoot -Path $_.FullName); bytes = $_.Length; sha256 = Get-Sha256 $_.FullName }
})
$manifest = [pscustomobject]@{ schemaVersion = 1; sourceSha = $sourceSha; flashMappings = $flashMappings; artifacts = $artifacts }
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $packageRoot 'ARTIFACT-MANIFEST.json') -Encoding utf8
$zipPath = "$packageRoot.zip"
Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $packageRoot -Force) -DestinationPath $zipPath -CompressionLevel Optimal
$zipHash = Get-Sha256 $zipPath
Set-Content -LiteralPath "$zipPath.sha256" -Value "$zipHash  $([IO.Path]::GetFileName($zipPath))" -Encoding ascii
Write-Host "Checkpoint package: $packageRoot"
Write-Host "Checkpoint ZIP: $zipPath"
Write-Host "Checkpoint ZIP SHA-256: $zipHash"
