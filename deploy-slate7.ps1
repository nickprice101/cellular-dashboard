Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Key = "$env:USERPROFILE\.ssh\slate7_deploy"
$HostName = "root@192.168.8.1"
$RemoteAppDir = "/root/mobile-data-dashboard"
$RemoteDistDir = "$RemoteAppDir/dist"
$RemoteLogFile = "/var/log/cellular-dashboard.log"

function Assert-LastExitCode {
    param(
        [string]$Step
    )

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
        ssh -i $Key -o IdentitiesOnly=yes $HostName $RemoteCommand
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

Run-Ssh "Check remote Node.js and npm" "node -v && npm -v"

Run-Ssh "Prepare remote directories" "mkdir -p $RemoteDistDir && rm -rf $RemoteDistDir/*"

$distFiles = Get-ChildItem -Path "dist" -Force | ForEach-Object { $_.FullName }
if (-not $distFiles -or $distFiles.Count -eq 0) {
    throw "dist folder is empty. Nothing to deploy."
}

Run-Scp "Upload built frontend" $distFiles "${HostName}:${RemoteDistDir}/" -Recursive

$serverFiles = @("server.js", "package.json", "package-lock.json")
foreach ($file in $serverFiles) {
    if (-not (Test-Path $file)) {
        throw "Required file missing: $file"
    }
}

Run-Scp "Upload server files" $serverFiles "${HostName}:${RemoteAppDir}/"

Run-Ssh "Install remote production dependencies" "cd $RemoteAppDir && npm ci --omit=dev"

Run-Ssh "Restart remote server" "pkill -f 'node server.js' || true; cd $RemoteAppDir && nohup node server.js > $RemoteLogFile 2>&1 &"

Run-Ssh "Verify remote server process" "pgrep -af 'node server.js'"

Write-Host ""
Write-Host "Deploy complete." -ForegroundColor Green
Write-Host "Remote log: $RemoteLogFile"
