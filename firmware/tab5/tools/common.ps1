Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:RepoRoot = (git -C (Join-Path $PSScriptRoot '..\..\..') rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0) { throw 'The helper scripts must run from the Tab5 repository.' }
$script:FirmwareRoot = Join-Path $script:RepoRoot 'firmware\tab5'
$script:IdfPath = 'C:\esp\v5.4.2\esp-idf'
$script:IdfToolsPath = 'C:\Espressif\tools'
$script:IdfPythonEnvPath = 'C:\Espressif\tools\python\v5.4.2\venv'
$script:IdfPython = Join-Path $script:IdfPythonEnvPath 'Scripts\python.exe'
$script:IdfCommand = Join-Path $script:IdfPath 'tools\idf.py'
$script:Tab5IdfExitCode = 0

function Invoke-Tab5Idf {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$IdfArguments,
        [switch]$StreamToHost
    )

    if ($StreamToHost) {
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            & $script:IdfPython $script:IdfCommand @IdfArguments 2>&1 | ForEach-Object { Write-Host $_ }
            $script:Tab5IdfExitCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
    }
    else {
        & $script:IdfPython $script:IdfCommand @IdfArguments
        $script:Tab5IdfExitCode = $LASTEXITCODE
    }
}

function Initialize-Tab5IdfEnvironment {
    foreach ($path in @(
        $script:IdfPath,
        (Join-Path $script:IdfPath 'export.ps1'),
        $script:IdfCommand,
        $script:IdfToolsPath,
        (Join-Path $script:IdfToolsPath 'espidf.constraints.v5.4.txt'),
        $script:IdfPythonEnvPath,
        $script:IdfPython
    )) {
        if (-not (Test-Path -LiteralPath $path)) { throw "Required ESP-IDF path is missing: $path" }
    }

    $env:IDF_TOOLS_PATH = $script:IdfToolsPath
    $env:IDF_PYTHON_ENV_PATH = $script:IdfPythonEnvPath
    . (Join-Path $script:IdfPath 'export.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'ESP-IDF activation failed; do not repair the environment automatically.' }

    if ($env:IDF_PATH -ne $script:IdfPath) { throw "Unexpected IDF_PATH after activation: $env:IDF_PATH" }
    $pythonPath = (Get-Command python -ErrorAction Stop).Source
    if ($pythonPath -ne $script:IdfPython) { throw "Unexpected Python after activation: $pythonPath" }
    $version = Invoke-Tab5Idf -IdfArguments @('--version')
    if ($script:Tab5IdfExitCode -ne 0 -or ($version -notmatch 'ESP-IDF v5\.4\.2')) {
        throw 'ESP-IDF 5.4.2 is not active; do not change the toolchain automatically.'
    }
}

function Set-Tab5FirmwareLocation {
    Set-Location -LiteralPath $script:FirmwareRoot
}

function Assert-Tab5SourceProvenance {
    param([Parameter(Mandatory = $true)][string]$SourceSha)

    $currentSha = (git -C $script:RepoRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $currentSha -notmatch '^[0-9a-f]{40}$') {
        throw 'Cannot determine the source commit before checkpoint finalization.'
    }
    if ($currentSha -ne $SourceSha) {
        throw "Source HEAD changed during the build: expected $SourceSha, found $currentSha."
    }

    git -C $script:RepoRoot diff --quiet
    if ($LASTEXITCODE -ne 0) {
        throw 'Tracked worktree changed during the build; refuse to finalize a baseline receipt.'
    }
    git -C $script:RepoRoot diff --cached --quiet
    if ($LASTEXITCODE -ne 0) {
        throw 'Tracked index changed during the build; refuse to finalize a baseline receipt.'
    }
}
