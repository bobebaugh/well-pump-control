[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^COM\d+$')]
    [string]$Port,
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ValidationPackageDirectory,
    [string]$ArtifactDirectory,
    [switch]$Mock
)

$ErrorActionPreference = 'Stop'

# Historical recovery evidence only. The verified-artifact helper deliberately does not
# accept this unsealed package or its fixed hashes as a flash source.
$legacyRecoveryArtifacts = @(
    [pscustomobject]@{ Path = 'BUILD-RECEIPT.md'; Length = 2753; Sha256 = '1e65fc90fb2cba0872ccd5af342fc0f6ee72d3bf4f83ebf61655ea791e9223b3' },
    [pscustomobject]@{ Path = 'flash_args'; Length = 159; Sha256 = '7f0c9b533865c14c949c9f9e6c2abb5c65a30a25fc1cb850a4baf0ae8cd691e6' },
    [pscustomobject]@{ Path = 'flash_project_args'; Length = 159; Sha256 = '7f0c9b533865c14c949c9f9e6c2abb5c65a30a25fc1cb850a4baf0ae8cd691e6' },
    [pscustomobject]@{ Path = 'flasher_args.json'; Length = 951; Sha256 = '899305d00c71fcc1f06c32e145be3accc39c686bc6b67abac1f830b98df04d13' },
    [pscustomobject]@{ Path = 'bootloader/bootloader.bin'; Length = 22240; Sha256 = '772c20e8ec883aff1a71d00c7b4e88f83681027a85fc3ed1cf35ebfdfcea4c7f' },
    [pscustomobject]@{ Path = 'partition_table/partition-table.bin'; Length = 3072; Sha256 = 'cc41e1665d8414083e3110de60589a523f99181ff55f361bf19ed035a0b79765' },
    [pscustomobject]@{ Path = 'well_pump_tab5.bin'; Length = 1398048; Sha256 = '10bada0124c6c7a9fbf6f543ea263e39481f38d7445629e59015df759ebbaa87' },
    [pscustomobject]@{ Path = 'well_pump_tab5.elf'; Length = 16462156; Sha256 = 'ef21fc90f4bbb76abbbca7e63a483af59b8deda0fb553a55e0b687bc85990491' },
    [pscustomobject]@{ Path = 'well_pump_tab5.map'; Length = 6817244; Sha256 = 'e3bae307bbccf9415a949e653c7c30f35c019bf2953171c28845b1ff4ecb4cea' }
)

$legacyRecoveryMappings = @(
    [pscustomobject]@{ Offset = '0x2000'; Path = 'bootloader/bootloader.bin' },
    [pscustomobject]@{ Offset = '0x10000'; Path = 'well_pump_tab5.bin' },
    [pscustomobject]@{ Offset = '0x8000'; Path = 'partition_table/partition-table.bin' }
)

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Resolve-PackageFile {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    $candidate = [System.IO.Path]::GetFullPath((Join-Path $Root $RelativePath))
    $rootWithSeparator = $Root.TrimEnd('\') + '\'
    if (-not $candidate.StartsWith($rootWithSeparator, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Package path escapes the artifact directory: $RelativePath"
    }
    return $candidate
}

function Get-ValidationPackageDefinition {
    param([Parameter(Mandatory = $true)][string]$Root)

    $incompletePath = Join-Path $Root 'INCOMPLETE'
    if (Test-Path -LiteralPath $incompletePath -PathType Leaf) {
        throw 'Validation package is explicitly marked INCOMPLETE.'
    }
    $successPath = Join-Path $Root 'SUCCESS'
    if (-not (Test-Path -LiteralPath $successPath -PathType Leaf)) {
        throw 'Validation package SUCCESS marker is missing.'
    }
    $receiptPath = Join-Path $Root 'BUILD-RECEIPT.md'
    if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) {
        throw 'Validation package receipt is missing.'
    }
    $manifestPath = Join-Path $Root 'ARTIFACT-MANIFEST.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw 'Validation package manifest is missing.'
    }
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    $success = Get-Content -Raw -LiteralPath $successPath | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 2 -or $manifest.sourceSha -notmatch '^[0-9a-f]{40}$') {
        throw 'Validation package manifest has an unsupported identity.'
    }
    if ($success.schemaVersion -ne 1 -or $success.sourceSha -ne $manifest.sourceSha -or
        $success.receipt.path -ne 'BUILD-RECEIPT.md' -or $success.manifest.path -ne 'ARTIFACT-MANIFEST.json') {
        throw 'Validation package SUCCESS marker does not agree with the manifest identity.'
    }
    if ((Get-Sha256 -Path $receiptPath) -ne $success.receipt.sha256 -or
        (Get-Sha256 -Path $manifestPath) -ne $success.manifest.sha256) {
        throw 'Validation package SUCCESS marker hash does not match the receipt or manifest.'
    }
    if ($null -eq $manifest.receipt -or $manifest.receipt.path -ne 'BUILD-RECEIPT.md' -or
        $manifest.receipt.sourceSha -ne $manifest.sourceSha -or $manifest.receipt.sha256 -ne $success.receipt.sha256) {
        throw 'Validation package receipt definition disagrees with SUCCESS or manifest identity.'
    }
    $artifacts = @($manifest.artifacts | ForEach-Object {
        if ([string]::IsNullOrWhiteSpace($_.path) -or $_.path -in @('ARTIFACT-MANIFEST.json', 'SUCCESS', 'INCOMPLETE') -or $_.sha256 -notmatch '^[0-9a-f]{64}$' -or $_.bytes -lt 0) {
            throw 'Validation package manifest has an invalid artifact entry.'
        }
        [pscustomobject]@{ Path = $_.path; Length = [int64]$_.bytes; Sha256 = $_.sha256 }
    })
    if ($artifacts.Count -eq 0) { throw 'Validation package manifest has no artifacts.' }
    foreach ($artifact in $artifacts) {
        $path = Resolve-PackageFile -Root $Root -RelativePath $artifact.Path
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required artifact is missing: $($artifact.Path)" }
        if ((Get-Item -LiteralPath $path).Length -ne $artifact.Length) { throw "Artifact size mismatch for $($artifact.Path)" }
        if ((Get-Sha256 -Path $path) -ne $artifact.Sha256) { throw "Artifact SHA-256 mismatch for $($artifact.Path)" }
    }
    $receiptArtifact = @($artifacts | Where-Object { $_.Path -eq 'BUILD-RECEIPT.md' })
    if ($receiptArtifact.Count -ne 1 -or $receiptArtifact[0].Sha256 -ne $manifest.receipt.sha256) {
        throw 'Validation package receipt is absent from or disagrees with the artifact manifest.'
    }
    foreach ($recorded in @($manifest.receipt.application, $manifest.receipt.elf)) {
        if ($null -eq $recorded -or [string]::IsNullOrWhiteSpace($recorded.path) -or $recorded.sha256 -notmatch '^[0-9a-f]{64}$') {
            throw 'Validation package receipt has an invalid recorded artifact.'
        }
        $artifact = @($artifacts | Where-Object { $_.Path -eq $recorded.path })
        if ($artifact.Count -ne 1 -or $artifact[0].Length -ne [int64]$recorded.bytes -or $artifact[0].Sha256 -ne $recorded.sha256) {
            throw "Validation package receipt and artifact manifest disagree for $($recorded.path)."
        }
    }
    if ($success.application.path -ne $manifest.receipt.application.path -or
        $success.application.bytes -ne $manifest.receipt.application.bytes -or
        $success.application.sha256 -ne $manifest.receipt.application.sha256) {
        throw 'Validation package SUCCESS marker and receipt disagree for the application binary.'
    }
    $receipt = Get-Content -Raw -LiteralPath $receiptPath
    foreach ($requiredReceiptValue in @(
        "Receipt identity: sourceSha=$($manifest.sourceSha)",
        "Receipt application: path=$($manifest.receipt.application.path) bytes=$($manifest.receipt.application.bytes) sha256=$($manifest.receipt.application.sha256)",
        "Receipt ELF: path=$($manifest.receipt.elf.path) bytes=$($manifest.receipt.elf.bytes) sha256=$($manifest.receipt.elf.sha256)"
    )) {
        if (-not $receipt.Contains($requiredReceiptValue)) {
            throw "Validation package receipt is missing required recorded value: $requiredReceiptValue"
        }
    }
    $mappings = @($manifest.flashMappings | ForEach-Object { [pscustomobject]@{ Offset = $_.offset; Path = $_.path } })
    $requiredMappings = @(
        [pscustomobject]@{ Offset = '0x2000'; Path = 'bootloader/bootloader.bin' },
        [pscustomobject]@{ Offset = '0x10000'; Path = 'well_pump_tab5.bin' },
        [pscustomobject]@{ Offset = '0x8000'; Path = 'partition_table/partition-table.bin' }
    )
    if ($mappings.Count -ne $requiredMappings.Count) { throw 'Validation package has an unexpected flash mapping count.' }
    foreach ($required in $requiredMappings) {
        if ($null -eq @($mappings | Where-Object { $_.Offset -eq $required.Offset -and $_.Path -eq $required.Path })[0]) {
            throw "Validation package is missing required mapping $($required.Offset) -> $($required.Path)."
        }
    }
    return [pscustomobject]@{ Artifacts = $artifacts; Mappings = $requiredMappings; SourceSha = $manifest.sourceSha }
}

if (-not [string]::IsNullOrWhiteSpace($ArtifactDirectory)) {
    throw 'Legacy -ArtifactDirectory mode is not permitted. Use a sealed -ValidationPackageDirectory with SUCCESS, receipt, and manifest validation.'
}
$artifactRoot = [System.IO.Path]::GetFullPath($ValidationPackageDirectory)

if (-not (Test-Path -LiteralPath $artifactRoot -PathType Container)) {
    throw "Artifact directory is missing: $artifactRoot"
}

$validationPackage = Get-ValidationPackageDefinition -Root $artifactRoot
$expectedArtifacts = $validationPackage.Artifacts
$expectedMappings = $validationPackage.Mappings
Write-Host "Verified validation package source: $($validationPackage.SourceSha)"

$flasherArgs = Get-Content -Raw -LiteralPath (Resolve-PackageFile -Root $artifactRoot -RelativePath 'flasher_args.json') | ConvertFrom-Json
if ($flasherArgs.extra_esptool_args.chip -ne 'esp32p4' -or $flasherArgs.extra_esptool_args.before -ne 'default_reset' -or $flasherArgs.extra_esptool_args.after -ne 'hard_reset') {
    throw 'Packaged esptool settings do not match the verified ESP32-P4 reset configuration.'
}

foreach ($mapping in $expectedMappings) {
    $packagedPath = $flasherArgs.flash_files.PSObject.Properties[$mapping.Offset].Value
    if ($packagedPath -ne $mapping.Path) {
        throw "Packaged address mapping mismatch at $($mapping.Offset): expected $($mapping.Path), found $packagedPath"
    }
}
if (@($flasherArgs.flash_files.PSObject.Properties).Count -ne @($expectedMappings).Count) {
    throw 'Packaged flasher mapping contains unexpected entries.'
}

$idfRoot = 'C:\esp\v5.4.2\esp-idf'
$python = 'C:\Espressif\tools\python\v5.4.2\venv\Scripts\python.exe'
$esptool = Join-Path $idfRoot 'components\esptool_py\esptool\esptool.py'
foreach ($toolPath in @($python, $esptool)) {
    if (-not (Test-Path -LiteralPath $toolPath -PathType Leaf)) {
        throw "Required ESP-IDF 5.4.2 esptool environment file is missing: $toolPath"
    }
}

$esptoolArguments = @('--chip', 'esp32p4', '-p', $Port, '-b', '460800', '--before', 'default_reset', '--after', 'hard_reset', 'write_flash')
$esptoolArguments += @($flasherArgs.write_flash_args)
foreach ($mapping in $expectedMappings) {
    $esptoolArguments += $mapping.Offset
    $esptoolArguments += Resolve-PackageFile -Root $artifactRoot -RelativePath $mapping.Path
}

Write-Host "Artifact directory: $artifactRoot"
Write-Host "Verified validation checkpoint: $(Split-Path -Leaf $artifactRoot)"
Write-Host 'Literal esptool arguments:'
$esptoolArguments | ForEach-Object { Write-Host "[$_]" }

if ($Mock) {
    Write-Host 'Mock complete: artifacts verified; no COM-port or device access occurred.'
    return
}

$serialPort = Get-CimInstance Win32_SerialPort | Where-Object { $_.DeviceID -eq $Port } | Select-Object -First 1
if ($null -eq $serialPort) {
    throw "Required serial port is not present: $Port"
}
if ($serialPort.Status -ne 'OK' -or $serialPort.PNPDeviceID -notmatch '(?i)VID_303A&PID_1001') {
    throw "Refusing to flash ${Port}: expected an operational Espressif VID_303A&PID_1001 device, found '$($serialPort.Name)' ($($serialPort.PNPDeviceID))."
}

$beforeHashes = @{}
foreach ($artifact in $expectedArtifacts) {
    $beforeHashes[$artifact.Path] = Get-Sha256 -Path (Resolve-PackageFile -Root $artifactRoot -RelativePath $artifact.Path)
}

try {
    $esptoolOutput = & $python $esptool @esptoolArguments 2>&1
    $exitCode = $LASTEXITCODE
    $esptoolOutput | ForEach-Object { Write-Host $_ }

    $outputText = ($esptoolOutput | Out-String)
    $verificationCount = ([regex]::Matches($outputText, 'Hash of data verified\.')).Count
    $resetObserved = $outputText -match 'Hard resetting via RTS pin'
    Write-Host "esptool exit code: $exitCode"
    Write-Host "Verified write hashes: $verificationCount/$($expectedMappings.Count)"
    Write-Host "Final hard reset observed: $resetObserved"

    if ($exitCode -ne 0) {
        throw "esptool failed with exit code $exitCode"
    }
    if ($verificationCount -ne $expectedMappings.Count) {
        throw 'esptool did not report verification for every packaged flash image.'
    }
    if (-not $resetObserved) {
        throw 'esptool did not report the required final hard reset.'
    }
}
finally {
    foreach ($artifact in $expectedArtifacts) {
        $afterHash = Get-Sha256 -Path (Resolve-PackageFile -Root $artifactRoot -RelativePath $artifact.Path)
        Write-Host "Post-esptool SHA-256 $($artifact.Path): $afterHash"
        if ($afterHash -ne $beforeHashes[$artifact.Path]) {
            throw "Artifact changed during esptool operation: $($artifact.Path)"
        }
    }
}
