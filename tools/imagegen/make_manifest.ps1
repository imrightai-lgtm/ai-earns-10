# make_manifest.ps1 - inventory source images into manifest.json (idempotent, keeps done entries).
#   powershell -NoProfile -ExecutionPolicy Bypass -File make_manifest.ps1 -ProjectDir "<abs>" -PhotosSubdir "input" -Styles a,b -PromptCount 2
# PhotosSubdir may be a non-ASCII folder name - pass it as an argument (data is fine; only script source must be ASCII).
# Reconstructed from IMAGE_GEN_PLAYBOOK.md - verify on first run.
param(
  [Parameter(Mandatory = $true)][string]$ProjectDir,
  [string]$PhotosSubdir = "input",
  [string[]]$Styles = @("default"),
  [int]$PromptCount = 1
)
$ErrorActionPreference = "Stop"
$photosPath = Join-Path $ProjectDir $PhotosSubdir
$manifestPath = Join-Path $ProjectDir "manifest.json"
if (-not (Test-Path $photosPath)) { Write-Error "Photos dir not found: $photosPath"; exit 1 }

# Keep existing done entries
$existing = @{}
if (Test-Path $manifestPath) {
  $old = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($it in $old.items) { if ($it.status -eq "done") { $existing[$it.source] = $it } }
}

$md5 = [System.Security.Cryptography.MD5]::Create()
function Get-NameHash([string]$name) {
  $h = $md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($name))
  return ([System.BitConverter]::ToString($h)).Replace("-", "").ToLower()
}

$files = Get-ChildItem -Path $photosPath -File |
  Where-Object { $_.Extension -match '\.(jpg|jpeg|png|webp|gif)$' } |
  Sort-Object { Get-NameHash $_.Name }

$items = @()
$i = 0
foreach ($f in $files) {
  $src = "$PhotosSubdir/$($f.Name)"
  if ($existing.ContainsKey($src)) { $items += $existing[$src]; $i++; continue }
  $items += [ordered]@{
    source = $src
    style = $Styles[$i % $Styles.Count]
    prompt_idx = $i % [Math]::Max($PromptCount, 1)
    status = "pending"; output = $null; attempts = 0; error = $null
    chat_url = $null; completed_at = $null
  }
  $i++
}

$manifest = [ordered]@{
  generated_at = (Get-Date).ToString("o")
  ordering = "md5(name) ascending"
  items = $items
}
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 6))
Write-Output "manifest: $($items.Count) items ($($files.Count) files)"
