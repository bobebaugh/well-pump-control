[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$script:MaximumPhysicalBuildRootLength = 80

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-RelativePackagePath {
    param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][string]$Path)
    return $Path.Substring($Root.TrimEnd('\').Length + 1).Replace('\', '/')
}

function New-ValidationBuildAttemptIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$SourceSha,
        [datetime]$UtcNow = [DateTime]::UtcNow,
        [string]$Nonce = [Guid]::NewGuid().ToString('N')
    )

    if ($SourceSha -notmatch '^[0-9a-f]{40}$') { throw 'Build attempt source SHA is invalid.' }
    if ($Nonce -notmatch '^[0-9a-f]{32}$') { throw 'Build attempt nonce is invalid.' }
    $timestamp = $UtcNow.ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ', [System.Globalization.CultureInfo]::InvariantCulture)
    return [pscustomobject]@{
        Identity = "$SourceSha-$timestamp-$($Nonce.Substring(0, 8))"
        ShortToken = $Nonce.Substring(0, 12)
        StartedUtc = $UtcNow.ToUniversalTime().ToString('o')
    }
}

function Assert-PhysicalBuildRootLength {
    param([Parameter(Mandatory = $true)][string]$BuildRoot)

    $fullPath = [System.IO.Path]::GetFullPath($BuildRoot)
    if ($fullPath.Length -gt $script:MaximumPhysicalBuildRootLength) {
        throw "Physical CMake build path is too long ($($fullPath.Length) characters; maximum $script:MaximumPhysicalBuildRootLength): $fullPath"
    }
    return $fullPath
}

function New-PhysicalBuildDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$FirmwareRoot,
        [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{12}$')][string]$ShortToken
    )

    $parent = Join-Path $FirmwareRoot 'b'
    if (Test-Path -LiteralPath $parent -PathType Leaf) { throw "Physical build parent is not a directory: $parent" }
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $buildRoot = Assert-PhysicalBuildRootLength -BuildRoot (Join-Path $parent $ShortToken)
    try {
        New-Item -ItemType Directory -Path $buildRoot -ErrorAction Stop | Out-Null
    }
    catch {
        if (Test-Path -LiteralPath $buildRoot) { throw "Refusing to reuse physical build directory: $buildRoot" }
        throw
    }
    return $buildRoot
}

function Resolve-PackagePath {
    param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][string]$RelativePath)
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $rootFull $RelativePath))
    if (-not $candidate.StartsWith("$rootFull\", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Package path escapes the checkpoint: $RelativePath"
    }
    return $candidate
}

function Assert-PackageManifest {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)]$Manifest
    )

    $entries = @($Manifest.artifacts)
    if ($entries.Count -eq 0) { throw 'Artifact manifest has no artifacts.' }
    foreach ($entry in $entries) {
        if ([string]::IsNullOrWhiteSpace($entry.path) -or $entry.sha256 -notmatch '^[0-9a-f]{64}$' -or $entry.bytes -lt 0) {
            throw 'Artifact manifest has an invalid entry.'
        }
        $path = Resolve-PackagePath -Root $Root -RelativePath $entry.path
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Package artifact is missing: $($entry.path)" }
        $item = Get-Item -LiteralPath $path
        if ($item.Length -ne [int64]$entry.bytes) { throw "Package artifact size mismatch: $($entry.path)" }
        if ((Get-Sha256 -Path $path) -ne $entry.sha256) { throw "Package artifact hash mismatch: $($entry.path)" }
    }

    $receiptEntry = @($entries | Where-Object { $_.path -eq $Manifest.receipt.path })
    if ($receiptEntry.Count -ne 1 -or $Manifest.receipt.path -ne 'BUILD-RECEIPT.md' -or
        $receiptEntry[0].sha256 -ne $Manifest.receipt.sha256 -or $Manifest.receipt.sourceSha -ne $Manifest.sourceSha) {
        throw 'Receipt and manifest identity disagree.'
    }
    foreach ($recorded in @($Manifest.receipt.application, $Manifest.receipt.elf)) {
        $artifact = @($entries | Where-Object { $_.path -eq $recorded.path })
        if ($artifact.Count -ne 1 -or $artifact[0].bytes -ne [int64]$recorded.bytes -or $artifact[0].sha256 -ne $recorded.sha256) {
            throw "Receipt and manifest artifact disagreement: $($recorded.path)"
        }
    }

    $receiptText = Get-Content -Raw -LiteralPath (Resolve-PackagePath -Root $Root -RelativePath 'BUILD-RECEIPT.md')
    foreach ($line in @(
        "Receipt identity: sourceSha=$($Manifest.sourceSha)",
        "Receipt application: path=$($Manifest.receipt.application.path) bytes=$($Manifest.receipt.application.bytes) sha256=$($Manifest.receipt.application.sha256)",
        "Receipt ELF: path=$($Manifest.receipt.elf.path) bytes=$($Manifest.receipt.elf.bytes) sha256=$($Manifest.receipt.elf.sha256)"
    )) {
        if (-not $receiptText.Contains($line)) { throw "Receipt is missing required recorded value: $line" }
    }
}

function Assert-CheckpointZip {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$ZipPath,
        [Parameter(Mandatory = $true)][string]$SuccessText
    )

    $expectedFiles = [System.Collections.Generic.Dictionary[string, string]]::new([System.StringComparer]::Ordinal)
    foreach ($file in @(Get-ChildItem -LiteralPath $Root -File -Recurse)) {
        $relative = Get-RelativePackagePath -Root $Root -Path $file.FullName
        if (-not $expectedFiles.TryAdd($relative, $file.FullName)) {
            throw "Checkpoint staging has duplicate relative path: $relative"
        }
    }
    $readArchive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $expectedCount = $expectedFiles.Count + 1
        if ($readArchive.Entries.Count -ne $expectedCount) { throw 'Checkpoint ZIP entry count mismatch.' }
        $archiveEntries = [System.Collections.Generic.Dictionary[string, System.IO.Compression.ZipArchiveEntry]]::new([System.StringComparer]::Ordinal)
        foreach ($entry in $readArchive.Entries) {
            if ([string]::IsNullOrEmpty($entry.FullName) -or $entry.FullName.EndsWith('/')) {
                throw "Checkpoint ZIP has an invalid directory entry: $($entry.FullName)"
            }
            if (-not $archiveEntries.TryAdd($entry.FullName, $entry)) {
                throw "Checkpoint ZIP has a duplicate entry: $($entry.FullName)"
            }
            if ($entry.FullName -ne 'SUCCESS' -and -not $expectedFiles.ContainsKey($entry.FullName)) {
                throw "Checkpoint ZIP has an unexpected entry: $($entry.FullName)"
            }
        }
        foreach ($relative in $expectedFiles.Keys) {
            if (-not $archiveEntries.ContainsKey($relative)) { throw "Checkpoint ZIP is missing entry: $relative" }
            $sourcePath = $expectedFiles[$relative]
            $sourceLength = (Get-Item -LiteralPath $sourcePath).Length
            $entry = $archiveEntries[$relative]
            if ($entry.Length -ne $sourceLength) { throw "Checkpoint ZIP entry size mismatch: $relative" }
            $sourceStream = [System.IO.File]::OpenRead($sourcePath)
            $entryStream = $entry.Open()
            try {
                $sourceBuffer = New-Object byte[] 65536
                $entryBuffer = New-Object byte[] 65536
                while ($true) {
                    $sourceRead = $sourceStream.Read($sourceBuffer, 0, $sourceBuffer.Length)
                    if ($sourceRead -eq 0) { break }
                    $entryRead = 0
                    while ($entryRead -lt $sourceRead) {
                        $read = $entryStream.Read($entryBuffer, $entryRead, $sourceRead - $entryRead)
                        if ($read -eq 0) { throw "Checkpoint ZIP entry is truncated: $relative" }
                        $entryRead += $read
                    }
                    for ($index = 0; $index -lt $sourceRead; ++$index) {
                        if ($sourceBuffer[$index] -ne $entryBuffer[$index]) { throw "Checkpoint ZIP entry content mismatch: $relative" }
                    }
                }
                if ($entryStream.ReadByte() -ne -1) { throw "Checkpoint ZIP entry has unexpected trailing data: $relative" }
            }
            finally { $entryStream.Dispose(); $sourceStream.Dispose() }
            $entryHashStream = $entry.Open()
            $hasher = [System.Security.Cryptography.SHA256]::Create()
            try {
                $entryHash = ([System.BitConverter]::ToString($hasher.ComputeHash($entryHashStream))).Replace('-', '').ToLowerInvariant()
            }
            finally { $hasher.Dispose(); $entryHashStream.Dispose() }
            if ($entryHash -ne (Get-Sha256 $sourcePath)) { throw "Checkpoint ZIP entry SHA-256 mismatch: $relative" }
        }
        if (-not $archiveEntries.ContainsKey('SUCCESS')) { throw 'Checkpoint ZIP is missing entry: SUCCESS' }
        $successBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($SuccessText)
        $successEntry = $archiveEntries['SUCCESS']
        if ($successEntry.Length -ne $successBytes.Length) { throw 'Checkpoint ZIP SUCCESS marker size mismatch.' }
        $successStream = $successEntry.Open()
        try {
            for ($index = 0; $index -lt $successBytes.Length; ++$index) {
                if ($successStream.ReadByte() -ne $successBytes[$index]) { throw 'Checkpoint ZIP SUCCESS marker content mismatch.' }
            }
            if ($successStream.ReadByte() -ne -1) { throw 'Checkpoint ZIP SUCCESS marker has unexpected trailing data.' }
        }
        finally { $successStream.Dispose() }
        $successHash = [System.Security.Cryptography.SHA256]::Create()
        try { $expectedSuccessHash = ([System.BitConverter]::ToString($successHash.ComputeHash($successBytes))).Replace('-', '').ToLowerInvariant() }
        finally { $successHash.Dispose() }
        $successHashStream = $successEntry.Open()
        $archiveSuccessHash = [System.Security.Cryptography.SHA256]::Create()
        try { $actualSuccessHash = ([System.BitConverter]::ToString($archiveSuccessHash.ComputeHash($successHashStream))).Replace('-', '').ToLowerInvariant() }
        finally { $archiveSuccessHash.Dispose(); $successHashStream.Dispose() }
        if ($actualSuccessHash -ne $expectedSuccessHash) { throw 'Checkpoint ZIP SUCCESS marker SHA-256 mismatch.' }
    }
    finally { $readArchive.Dispose() }
}

function New-CheckpointZip {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$ZipPath,
        [Parameter(Mandatory = $true)][string]$SuccessText
    )

    if (Test-Path -LiteralPath $ZipPath) { throw "Refusing to overwrite checkpoint ZIP: $ZipPath" }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $files = @(Get-ChildItem -LiteralPath $Root -File -Recurse)
    $stream = [System.IO.File]::Open($ZipPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        foreach ($file in $files) {
            $relative = Get-RelativePackagePath -Root $Root -Path $file.FullName
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive, $file.FullName, $relative, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
        $successEntry = $archive.CreateEntry('SUCCESS', [System.IO.Compression.CompressionLevel]::Optimal)
        $writer = [System.IO.StreamWriter]::new($successEntry.Open(), [System.Text.UTF8Encoding]::new($false))
        try { $writer.Write($SuccessText) } finally { $writer.Dispose() }
    }
    finally {
        $archive.Dispose()
        $stream.Dispose()
    }
    Assert-CheckpointZip -Root $Root -ZipPath $ZipPath -SuccessText $SuccessText
}

$exitCode = 1
$transcriptStarted = $false
try {
    Set-Location -LiteralPath $script:RepoRoot
    git diff --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Tracked worktree is not clean; refuse to produce a baseline receipt.' }
    git diff --cached --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Tracked index is not clean; refuse to produce a baseline receipt.' }
    $sourceSha = (git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $sourceSha -notmatch '^[0-9a-f]{40}$') { throw 'Cannot determine the source commit.' }
    $sourceBranch = (git branch --show-current).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($sourceBranch)) { throw 'Cannot determine the source branch.' }

    $buildRoot = $null
    $packageRoot = $null
    for ($attempt = 0; $attempt -lt 1000; ++$attempt) {
        $buildAttempt = New-ValidationBuildAttemptIdentity -SourceSha $sourceSha
        $identity = $buildAttempt.Identity
        $shortBuildToken = $buildAttempt.ShortToken
        $candidatePackage = Join-Path $script:FirmwareRoot "checkpoints\tab5-validation-$identity"
        if ((Test-Path -LiteralPath $candidatePackage) -or (Test-Path -LiteralPath "$candidatePackage.zip") -or (Test-Path -LiteralPath "$candidatePackage.zip.sha256")) { continue }
        try {
            $buildRoot = New-PhysicalBuildDirectory -FirmwareRoot $script:FirmwareRoot -ShortToken $shortBuildToken
            $packageRoot = $candidatePackage
            break
        }
        catch {
            if ($_.Exception.Message -notmatch '^Refusing to reuse physical build directory:') { throw }
        }
    }
    if ($null -eq $buildRoot) { throw 'Could not reserve a unique build/checkpoint identity.' }

    $logPath = Join-Path $buildRoot 'BUILD-CONSOLE.log'
    $incompleteMarker = Join-Path $buildRoot 'INCOMPLETE'
    @(
        'This build attempt is incomplete unless its paired checkpoint package contains SUCCESS.',
        "Identity: $identity",
        "Physical build path: $buildRoot",
        "Source SHA: $sourceSha",
        "Started UTC: $($buildAttempt.StartedUtc)"
    ) | Set-Content -LiteralPath $incompleteMarker -Encoding utf8
    Start-Transcript -Path $logPath -Force | Out-Null
    $transcriptStarted = $true
    Write-Host "Build attempt identity: $identity"
    Write-Host "Build directory: $buildRoot"
    Write-Host "Console log: $logPath"

    $configInput = Join-Path $script:FirmwareRoot 'config\sdkconfig.validation.defaults'
    $generatedSdkconfig = Join-Path $buildRoot 'sdkconfig'
    if (-not (Test-Path -LiteralPath $configInput -PathType Leaf)) { throw "Tracked validation configuration is missing: $configInput" }

    Initialize-Tab5IdfEnvironment
    $idfArguments = @('-B', $buildRoot, '-D', 'IDF_TARGET=esp32p4', '-D', "SDKCONFIG=$generatedSdkconfig", '-D', "SDKCONFIG_DEFAULTS=$configInput", 'build')
    Set-Tab5FirmwareLocation
    Invoke-Tab5Idf -IdfArguments $idfArguments
    $idfExitCode = $LASTEXITCODE
    if ($idfExitCode -ne 0) { $exitCode = $idfExitCode; throw "ESP-IDF build failed with exit code $idfExitCode." }
    Invoke-Tab5Idf -IdfArguments @('-B', $buildRoot, '-D', "SDKCONFIG=$generatedSdkconfig", 'size')
    $idfExitCode = $LASTEXITCODE
    if ($idfExitCode -ne 0) { $exitCode = $idfExitCode; throw "ESP-IDF size failed with exit code $idfExitCode." }

    $requiredBuildFiles = @(
        'flash_args', 'flasher_args.json', 'bootloader\bootloader.bin', 'partition_table\partition-table.bin',
        'well_pump_tab5.bin', 'well_pump_tab5.elf', 'well_pump_tab5.map', 'sdkconfig'
    )
    foreach ($relative in $requiredBuildFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $buildRoot $relative) -PathType Leaf)) { throw "Required build output is missing: $relative" }
    }

    Assert-Tab5SourceProvenance -SourceSha $sourceSha
    New-Item -ItemType Directory -Path $packageRoot -ErrorAction Stop | Out-Null
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
    $application = [pscustomobject]@{ path = 'well_pump_tab5.bin'; bytes = (Get-Item -LiteralPath (Join-Path $buildRoot 'well_pump_tab5.bin')).Length; sha256 = Get-Sha256 (Join-Path $buildRoot 'well_pump_tab5.bin') }
    $elf = [pscustomobject]@{ path = 'well_pump_tab5.elf'; bytes = (Get-Item -LiteralPath (Join-Path $buildRoot 'well_pump_tab5.elf')).Length; sha256 = Get-Sha256 (Join-Path $buildRoot 'well_pump_tab5.elf') }
    $idfVersion = (Invoke-Tab5Idf -IdfArguments @('--version') | Out-String).Trim()
    $idfExitCode = $LASTEXITCODE
    if ($idfExitCode -ne 0) { $exitCode = $idfExitCode; throw "ESP-IDF version query failed with exit code $idfExitCode." }
    $pythonVersion = (& $script:IdfPython --version 2>&1 | Out-String).Trim()
    $idfExitCode = $LASTEXITCODE
    if ($idfExitCode -ne 0) { $exitCode = $idfExitCode; throw "Python version query failed with exit code $idfExitCode." }
    $receipt = @(
        '# Tab5 validation baseline build receipt', '',
        "Generated UTC: ``$(Get-Date -AsUTC -Format 'yyyy-MM-ddTHH:mm:ssZ')``",
        "Source branch: ``$sourceBranch``", "Source SHA: ``$sourceSha``", 'Tracked worktree state: `clean`',
        "Checkpoint identity: ``$identity``", "Physical CMake build directory: ``$buildRoot``", "Physical build directory token: ``$shortBuildToken``",
        "ESP-IDF path: ``$script:IdfPath``", "ESP-IDF version: ``$idfVersion``",
        "Python path: ``$script:IdfPython``", "Python version: ``$pythonVersion``",
        "Build command: ``idf.py $($idfArguments -join ' ')``",
        "Tracked configuration input: ``config/sdkconfig.validation.defaults`` SHA-256 ``$(Get-Sha256 $configInput)``",
        "Generated sdkconfig SHA-256: ``$(Get-Sha256 $generatedSdkconfig)``",
        "dependencies.lock SHA-256: ``$(Get-Sha256 (Join-Path $script:FirmwareRoot 'dependencies.lock'))``",
        'Resolved managed-component versions and hashes are preserved verbatim in `provenance/dependencies.lock`.',
        'Declared component constraints are preserved in `provenance/main-idf_component.yml`; local component manifests are under `provenance/components/`.',
        "Application binary: ``$($application.path)`` bytes ``$($application.bytes)`` SHA-256 ``$($application.sha256)``",
        "Application ELF: ``$($elf.path)`` bytes ``$($elf.bytes)`` SHA-256 ``$($elf.sha256)``",
        "Receipt identity: sourceSha=$sourceSha",
        "Receipt application: path=$($application.path) bytes=$($application.bytes) sha256=$($application.sha256)",
        "Receipt ELF: path=$($elf.path) bytes=$($elf.bytes) sha256=$($elf.sha256)",
        '', 'Flash mappings:', ($flashMappings | ForEach-Object { "- ``$($_.offset)`` → ``$($_.path)``" })
    )
    $receiptPath = Join-Path $packageRoot 'BUILD-RECEIPT.md'
    Set-Content -LiteralPath $receiptPath -Value $receipt -Encoding utf8
    $receiptDefinition = [pscustomobject]@{ path = 'BUILD-RECEIPT.md'; sha256 = Get-Sha256 $receiptPath; sourceSha = $sourceSha; application = $application; elf = $elf }
    $artifacts = @(Get-ChildItem -LiteralPath $packageRoot -File -Recurse | ForEach-Object {
        [pscustomobject]@{ path = (Get-RelativePackagePath -Root $packageRoot -Path $_.FullName); bytes = $_.Length; sha256 = Get-Sha256 $_.FullName }
    })
    $manifest = [pscustomobject]@{ schemaVersion = 2; sourceSha = $sourceSha; flashMappings = $flashMappings; receipt = $receiptDefinition; artifacts = $artifacts }
    $manifestPath = Join-Path $packageRoot 'ARTIFACT-MANIFEST.json'
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8
    Assert-PackageManifest -Root $packageRoot -Manifest $manifest

    $success = [pscustomobject]@{
        schemaVersion = 1; sourceSha = $sourceSha; completedUtc = [DateTime]::UtcNow.ToString('o')
        receipt = [pscustomobject]@{ path = 'BUILD-RECEIPT.md'; sha256 = $receiptDefinition.sha256 }
        manifest = [pscustomobject]@{ path = 'ARTIFACT-MANIFEST.json'; sha256 = Get-Sha256 $manifestPath }
        application = $application
    }
    $successText = $success | ConvertTo-Json -Depth 5
    $zipPath = "$packageRoot.zip"
    New-CheckpointZip -Root $packageRoot -ZipPath $zipPath -SuccessText $successText
    $zipHash = Get-Sha256 $zipPath
    Set-Content -LiteralPath "$zipPath.sha256" -Value "$zipHash  $([IO.Path]::GetFileName($zipPath))" -Encoding ascii
    Set-Content -LiteralPath (Join-Path $packageRoot 'SUCCESS') -Value $successText -Encoding utf8

    $exitCode = 0
    Write-Host "Checkpoint package: $packageRoot"
    Write-Host "Build receipt: $receiptPath"
    Write-Host "Application SHA-256: $($application.sha256)"
    Write-Host "Checkpoint ZIP: $zipPath"
    Write-Host "Checkpoint ZIP SHA-256: $zipHash"
}
catch {
    Write-Host "Build attempt failed: $($_.Exception.Message)"
    if ($exitCode -eq 0) { $exitCode = 1 }
}
finally {
    if ($transcriptStarted) { Stop-Transcript | Out-Null }
}
exit $exitCode
