Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Key = "$env:USERPROFILE\.ssh\slate7_deploy"
$HostName = "root@192.168.8.1"
$RemoteAppDir = "/root/mobile-data-dashboard"
$RemoteDistDir = "$RemoteAppDir/dist"
$RemoteLogFile = "/var/log/cellular-dashboard.log"
$RemotePidFile = "/var/run/cellular-dashboard.pid"
$LocalRemoteScript = Join-Path $PWD ".remote-deploy.sh"
$RemoteScriptPath = "/tmp/remote-deploy.sh"

function Assert-LastExitCode {
    param([string]$Step)
    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed with exit code $LASTEXITCODE."
    }
}

function Run-Step {
    param(
        [string]$Name,
        [scriptblock]$Command
    )

    Write-Host ""
    Write-Host "==> $Name" -ForegroundColor Cyan
    & $Command
    Assert-LastExitCode $Name
}

function Run-Ssh {
    param(
        [string]$Name,
        [string]$RemoteCommand
    )

    Run-Step $Name {
        & ssh -T -i $Key -o IdentitiesOnly=yes $HostName $RemoteCommand
    }
}

function Run-Scp {
    param(
        [string]$Name,
        [string[]]$Sources,
        [string]$Destination,
        [switch]$Recursive
    )

    Run-Step $Name {
        $scpArgs = @("-O", "-i", $Key, "-o", "IdentitiesOnly=yes")
        if ($Recursive) {
            $scpArgs += "-r"
        }
        $scpArgs += $Sources
        $scpArgs += $Destination
        & scp @scpArgs
    }
}

function Write-Utf8NoBomLf {
    param(
        [string]$Path,
        [string]$Content
    )

    $lfContent = $Content -replace "`r`n", "`n" -replace "`r", "`n"
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $lfContent, $utf8NoBom)
}

Write-Host "Starting deploy to Slate 7..." -ForegroundColor Green

if (-not (Test-Path $Key)) {
    throw "SSH private key not found: $Key"
}

if (-not (Test-Path ".git")) {
    throw "This script must be run from the repository root."
}

Run-Step "Fetch latest repo state" {
    git fetch origin
}

Run-Step "Reset to origin/main" {
    git reset --hard origin/main
}

Run-Step "Remove untracked files" {
    git clean -fd
}

Run-Step "Install local dependencies" {
    npm install
}

Run-Step "Build app" {
    npm run build
}

if (-not (Test-Path "dist")) {
    throw "Build completed but dist folder was not found."
}

$distFiles = Get-ChildItem -Path "dist" -Force
if (-not $distFiles -or $distFiles.Count -eq 0) {
    throw "dist folder is empty. Nothing to deploy."
}

$serverFiles = @("server.js", "package.json", "package-lock.json")
foreach ($file in $serverFiles) {
    if (-not (Test-Path $file)) {
        throw "Required file missing: $file"
    }
}

Run-Ssh "Check remote tools" "node -v && npm -v && command -v start-stop-daemon && command -v wget"

Run-Ssh "Prepare remote directories" "mkdir -p $RemoteDistDir && rm -rf $RemoteDistDir/* && mkdir -p $RemoteAppDir"

Run-Scp "Upload built frontend" @("dist/*") "${HostName}:${RemoteDistDir}/" -Recursive
Run-Scp "Upload server files" $serverFiles "${HostName}:${RemoteAppDir}/"

$remoteScript = @"
#!/bin/sh
set -e

APP_DIR="$RemoteAppDir"
LOG_FILE="$RemoteLogFile"
PID_FILE="$RemotePidFile"

cd "$RemoteAppDir"

npm ci --omit=dev

start-stop-daemon -K -p "$RemotePidFile" >/dev/null 2>&1 || true
pkill -f "node server.js" >/dev/null 2>&1 || true
rm -f "$RemotePidFile"

start-stop-daemon -S -b -m -p "$RemotePidFile" -x /bin/sh -- -c "exec node server.js >>$RemoteLogFile 2>&1"

sleep 3

echo "=== PID FILE ==="
if [ -s "$RemotePidFile" ]; then
  cat "$RemotePidFile"
else
  echo "No PID file created"
fi

echo "=== LOG TAIL ==="
tail -n 50 "$RemoteLogFile" 2>/dev/null || true
"@

Write-Utf8NoBomLf -Path $LocalRemoteScript -Content $remoteScript

try {
    Run-Scp "Upload remote control script" @($LocalRemoteScript) "${HostName}:${RemoteScriptPath}"
    Run-Ssh "Run remote control script" "chmod +x $RemoteScriptPath && sed -i 's/\r$//' $RemoteScriptPath && sh $RemoteScriptPath"
}
finally {
    if (Test-Path $LocalRemoteScript) {
        Remove-Item $LocalRemoteScript -Force
    }
}

Write-Host ""
Write-Host "Deploy complete." -ForegroundColor Green
Write-Host "Remote log: $RemoteLogFile"
Write-Host "Remote PID file: $RemotePidFile"
