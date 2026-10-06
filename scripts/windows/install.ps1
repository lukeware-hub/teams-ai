# Installs the Windows prerequisites of Teams AI: WSL2 (Ubuntu), Git, Docker Desktop and Task.
# Safe to run more than once: anything already installed is skipped.
# Run in an elevated PowerShell:  powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1
$ErrorActionPreference = 'Stop'

function Write-Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }

$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'Abra o PowerShell como Administrador e rode este script de novo.' -ForegroundColor Red
    exit 1
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host 'O winget não foi encontrado. Instale o "App Installer" pela Microsoft Store e rode de novo.' -ForegroundColor Red
    exit 1
}

$rebootNeeded = $false

Write-Step 'WSL2 + Ubuntu'
$distros = (& wsl.exe -l -q 2>$null) -join '' -replace "`0", ''
if ($distros -match 'Ubuntu') {
    Write-Host 'Ubuntu já instalado no WSL, nada a fazer.'
} else {
    & wsl.exe --install -d Ubuntu
    $rebootNeeded = $true
}

$packages = @(
    @{ Id = 'Git.Git'; Name = 'Git' },
    @{ Id = 'Docker.DockerDesktop'; Name = 'Docker Desktop' },
    @{ Id = 'Task.Task'; Name = 'Task' }
)
foreach ($package in $packages) {
    Write-Step $package.Name
    & winget list --id $package.Id -e --accept-source-agreements 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "$($package.Name) já instalado, nada a fazer."
    } else {
        & winget install --id $package.Id -e --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0) { throw "Falha ao instalar $($package.Name)." }
        if ($package.Id -eq 'Docker.DockerDesktop') { $rebootNeeded = $true }
    }
}

Write-Host ''
if ($rebootNeeded) {
    Write-Host 'Reinicie o computador. Depois abra o Ubuntu uma vez (para criar seu usuário) e o Docker Desktop (espere "Engine running").' -ForegroundColor Yellow
} else {
    Write-Host 'Pré-requisitos instalados. Abra o Docker Desktop e espere "Engine running".' -ForegroundColor Green
}
Write-Host 'Em um novo terminal, dentro da pasta do projeto, rode:  task start' -ForegroundColor Green
