param(
    [switch]$Desktop,
    [switch]$StartMenu,
    [string]$Name = "YouTube Music Client"
)

$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent $PSScriptRoot
$electronExe = Join-Path $projectDir "node_modules\electron\dist\electron.exe"
$iconPath = Join-Path $projectDir "assets\icon.ico"

if (-not (Test-Path $electronExe)) {
    Write-Error "Electron binary not found at $electronExe. Run npm.cmd install first."
    exit 1
}

if (-not (Test-Path $iconPath)) {
    Write-Warning "Icon not found at $iconPath. Run npm.cmd run assets:icons to generate assets."
}

$targetDir = if ($Desktop) {
    [Environment]::GetFolderPath("Desktop")
} elseif ($StartMenu) {
    [Environment]::GetFolderPath("Programs")
} else {
    $projectDir
}

if (-not (Test-Path $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
}

$shortcutPath = Join-Path $targetDir "$Name.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $electronExe
$shortcut.Arguments = "`"$projectDir`""
$shortcut.WorkingDirectory = $projectDir
if (Test-Path $iconPath) {
    $shortcut.IconLocation = "$iconPath,0"
}
$shortcut.Description = "YouTube Music Desktop Client"
$shortcut.WindowStyle = 1
$shortcut.Save()

Write-Output "Created shortcut: $shortcutPath"
