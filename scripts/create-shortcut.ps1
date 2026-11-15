param(
    [switch]$Desktop,
    [switch]$StartMenu,
    [string]$Name = "YouTube Music Client"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Name)) {
    throw "Invalid shortcut name: name cannot be empty or whitespace."
}
if ($Name.Trim() -ne $Name -or $Name -eq "." -or $Name.Contains("..") -or $Name.IndexOfAny([char[]]@('/', '\', ':')) -ge 0) {
    throw "Invalid shortcut name '$Name': path separators, drive letters, leading/trailing whitespace, and traversal sequences are not allowed."
}
if ($Name.IndexOfAny([System.IO.Path]::GetInvalidFileNameChars()) -ge 0) {
    throw "Invalid shortcut name '$Name': contains invalid filename characters."
}

$projectDir = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($projectDir)) {
    throw "Unable to resolve project root directory."
}
$electronExe = Join-Path $projectDir "node_modules\electron\dist\electron.exe"
$iconPath = Join-Path $projectDir "assets\icon.ico"

if (-not (Test-Path $electronExe)) {
    Write-Error "Electron binary not found at $electronExe. Run npm.cmd ci first."
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

if ([string]::IsNullOrWhiteSpace($targetDir)) {
    throw "Unable to resolve target directory for shortcut."
}
$resolvedTargetDir = [System.IO.Path]::GetFullPath($targetDir)
$targetDirPrefix = if ($resolvedTargetDir.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
    $resolvedTargetDir
} else {
    "$resolvedTargetDir$([System.IO.Path]::DirectorySeparatorChar)"
}

if (-not (Test-Path $resolvedTargetDir)) {
    New-Item -ItemType Directory -Path $resolvedTargetDir -Force | Out-Null
}

$shortcutPath = [System.IO.Path]::GetFullPath((Join-Path $resolvedTargetDir "$Name.lnk"))
if (-not $shortcutPath.StartsWith($targetDirPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Resolved shortcut path escapes target directory: $shortcutPath"
}

$trimmedProjectDir = $projectDir.TrimEnd('\', '/')
$quotedProjectArg = if ($trimmedProjectDir -match '^[A-Za-z]:$') {
    "`"$trimmedProjectDir\\`""
} else {
    "`"$($trimmedProjectDir.Replace('"', '\"'))`""
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $electronExe
$shortcut.Arguments = $quotedProjectArg
$shortcut.WorkingDirectory = $projectDir
if (Test-Path $iconPath) {
    $shortcut.IconLocation = "$iconPath,0"
}
$shortcut.Description = "YouTube Music Desktop Client"
$shortcut.WindowStyle = 1
$shortcut.Save()

Write-Output "Created shortcut: $shortcutPath"
