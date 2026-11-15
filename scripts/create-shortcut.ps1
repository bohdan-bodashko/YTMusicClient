param(
    [switch]$Desktop
)

$projectDir = Split-Path -Parent $PSScriptRoot
$electronExe = Join-Path $projectDir "node_modules\electron\dist\electron.exe"
$iconPath = Join-Path $projectDir "assets\icon.ico"

if (-not (Test-Path $electronExe)) {
    Write-Error "Electron binary not found at $electronExe. Run npm.cmd install first."
    exit 1
}

$targetDir = if ($Desktop) {
    [Environment]::GetFolderPath("Desktop")
} else {
    $projectDir
}

$shortcutPath = Join-Path $targetDir "YouTube Music.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $electronExe
$shortcut.Arguments = "`"$projectDir`""
$shortcut.WorkingDirectory = $projectDir
$shortcut.IconLocation = "$iconPath,0"
$shortcut.Description = "YouTube Music Desktop Client"
$shortcut.Save()

Write-Output "Created shortcut: $shortcutPath"
