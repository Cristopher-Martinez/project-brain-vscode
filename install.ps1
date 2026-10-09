# Install Project Brain Extension

Write-Host "🧠 Installing Project Brain Extension..." -ForegroundColor Cyan

$extensionPath = $PSScriptRoot

# Check if compiled
if (!(Test-Path "$extensionPath\dist\extension.js")) {
    Write-Host "❌ Extension not compiled. Run 'npm run compile' first." -ForegroundColor Red
    exit 1
}

# Create symlink to VS Code extensions folder
$vscodeExtensions = "$env:USERPROFILE\.vscode\extensions"
$targetPath = "$vscodeExtensions\clawdbot.project-brain-0.1.0"

if (Test-Path $targetPath) {
    Write-Host "🔄 Removing existing installation..." -ForegroundColor Yellow
    Remove-Item $targetPath -Recurse -Force
}

Write-Host "📦 Creating symlink..." -ForegroundColor Cyan
New-Item -ItemType SymbolicLink -Path $targetPath -Target $extensionPath | Out-Null

Write-Host "✅ Extension installed!" -ForegroundColor Green
Write-Host ""
Write-Host "To activate:" -ForegroundColor Yellow
Write-Host "1. Restart VS Code or run 'Developer: Reload Window'" -ForegroundColor White
Write-Host "2. Run command: 'Project Brain: Initialize Project Memory'" -ForegroundColor White
Write-Host ""
Write-Host "Extension location: $targetPath" -ForegroundColor Gray
