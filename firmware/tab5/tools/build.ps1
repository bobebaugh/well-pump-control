[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-RelativePackagePath {
    param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][string]$Path)
    return $Path.Substring($Root.TrimEnd('\').Length + 1).Replace('\', '/')
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

function New-CheckpointZip {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$ZipPath,
        [Parameter(Mandatory = $true)][string]$SuccessText
    )

    if (Test-Path -LiteralPath $ZipPath) { throw "Refusing to overwrite checkpoint ZIP: $ZipPath" }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $files = @(Get-ChildItem -LiteralPath $Root -File -Recurse)
    $entryNames = @()
    $stream = [System.IO.File]::Open($ZipPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        foreach ($file in $files) {
            $relative = Get-RelativePackagePath -Root $Root -Path $file.FullName
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive, $file.FullName, $relative, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
            $entryNames += $relative
        }
        $successEntry = $archive.CreateEntry('SUCCESS', [System.IO.Compression.CompressionLevel]::Optimal)
        $writer = [System.IO.StreamWriter]::new($successEntry.Open(), [System.Text.UTF8Encoding]::new($false))
        try { $writer.Write($SuccessText) } finally { $writer.Dispose() }
    }
    finally {
        $archive.Dispose()
        $stream.Dispose()
    }

    $readArchive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $actualNames = @($readArchive.Entries | ForEach-Object { $_.FullName })
        $expectedNames = @($entryNames + 'SUCCESS')
        if ($actualNames.Count -ne $expectedNames.Count) { throw 'Checkpoint ZIP entry count mismatch.' }
        foreach ($expectedName in $expectedNames) {
            if ($null -eq @($actualNames | Where-Object { $_ -ceq $expectedName })[0]) {
                throw "Checkpoint ZIP is missing entry: $expectedName"
            }
        }
        $successEntry = $readArchive.GetEntry('SUCCESS')
        $reader = [System.IO.StreamReader]::new($successEntry.Open(), [System.Text.UTF8Encoding]::new($false))
        try {
            if ($reader.ReadToEnd() -cne $SuccessText) { throw 'Checkpoint ZIP SUCCESS marker does not match the verified package marker.' }
        }
        finally { $reader.Dispose() }
    }
    finally { $readArchive.Dispose() }
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

    $timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ', [System.Globalization.CultureInfo]::InvariantCulture)
    $identityBase = "$sourceSha-$timestamp-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
    $buildRoot = $null
    $packageRoot = $null
    for ($attempt = 0; $attempt -lt 1000; ++$attempt) {
        $identity = if ($attempt -eq 0) { $identityBase } else { "$identityBase-$attempt" }
        $candidateBuild = Join-Path $script:FirmwareRoot "build-validation-$identity"
        $candidatePackage = Join-Path $script:FirmwareRoot "checkpoints\tab5-validation-$identity"
        if ((Test-Path -LiteralPath $candidatePackage) -or (Test-Path -LiteralPath "$candidatePackage.zip") -or (Test-Path -LiteralPath "$candidatePackage.zip.sha256")) { continue }
        try {
            New-Item -ItemType Directory -Path $candidateBuild -ErrorAction Stop | Out-Null
            $buildRoot = $candidateBuild
            $packageRoot = $candidatePackage
            break
        }
        catch {
            if (-not (Test-Path -LiteralPath $candidateBuild)) { throw }
        }
    }
    if ($null -eq $buildRoot) { throw 'Could not reserve a unique build/checkpoint identity.' }

    $logPath = Join-Path $buildRoot 'BUILD-CONSOLE.log'
    $incompleteMarker = Join-Path $buildRoot 'INCOMPLETE'
    @(
        'This build attempt is incomplete unless its paired checkpoint package contains SUCCESS.',
        "Identity: $identity",
        "Source SHA: $sourceSha",
        "Started UTC: $([DateTime]::UtcNow.ToString('o'))"
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
