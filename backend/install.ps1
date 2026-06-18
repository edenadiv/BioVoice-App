# BioVoice backend — full setup for Windows (Python 3.11 required)
#
# Usage (from repo root):
#   .\backend\install.ps1
#
# Creates / reuses .venv, installs all deps, then pre-downloads F5-TTS
# and Vocos weights so the first clone request never stalls.

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
$Venv = Join-Path $Root ".venv"
$Py311 = "C:\Users\$env:USERNAME\AppData\Local\Programs\Python\Python311\python.exe"

# 1 — create venv if it doesn't exist
if (-not (Test-Path "$Venv\Scripts\python.exe")) {
    if (-not (Test-Path $Py311)) {
        Write-Error "Python 3.11 not found at $Py311 — install it first."
        exit 1
    }
    Write-Host "Creating Python 3.11 venv..."
    & $Py311 -m venv $Venv
}

$Pip = "$Venv\Scripts\pip.exe"
$Python = "$Venv\Scripts\python.exe"

# 2 — install pinned requirements
Write-Host "Installing requirements..."
& $Pip install -r "$PSScriptRoot\requirements.txt"

# 3 — pre-download F5-TTS + Vocos weights
Write-Host "Downloading F5-TTS model weights..."
& $Python "$PSScriptRoot\scripts\download_f5tts_models.py"

Write-Host "Setup complete."
