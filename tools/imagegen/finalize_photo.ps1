# finalize_photo.ps1 - wait for file in Downloads (retry 20s) -> out/<style>/ -> update manifest.
#   powershell -NoProfile -ExecutionPolicy Bypass -File finalize_photo.ps1 -Index N -ProjectDir "<abs>" -ChatUrl "https://chatgpt.com/c/<id>"
# Reconstructed from IMAGE_GEN_PLAYBOOK.md - verify on first run. ASCII-only for Windows PowerShell 5.1.
param(
  [Parameter(Mandatory = $true)][int]$Index,
  [Parameter(Mandatory = $true)][string]$ProjectDir,
  [string]$ChatUrl = $null,
  [int]$Port = 8765,
  [string]$DownloadsDir = (Join-Path $env:USERPROFILE "Downloads")
)
$ErrorActionPreference = "Stop"
# Stop listener (best-effort)
try { Invoke-WebRequest -Uri "http://127.0.0.1:$Port/stop" -TimeoutSec 2 -UseBasicParsing | Out-Null } catch {}

$manifestPath = Join-Path $ProjectDir "manifest.json"
$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$item = $manifest.items[$Index]
if (-not $item) { Write-Error "No item at index $Index"; exit 1 }
$basename = [System.IO.Path]::GetFileNameWithoutExtension($item.source)
$expected = Join-Path $DownloadsDir "$basename.png"

# Wait for download (retry 20s); browser may append a " (1)" suffix
$found = $null
for ($t = 0; $t -lt 20; $t++) {
  if (Test-Path $expected) { $found = $expected; break }
  $alt = Get-ChildItem -Path $DownloadsDir -Filter "$basename*.png" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($alt) { $found = $alt.FullName; break }
  Start-Sleep -Seconds 1
}
if (-not $found) {
  $item.status = "error"; $item.error = "download not found in $DownloadsDir"; $item.attempts++
  [System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 6))
  Write-Output "ERROR index=$Index download not found"; exit 2
}

$outDir = Join-Path (Join-Path $ProjectDir "out") $item.style
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$dest = Join-Path $outDir "$basename.png"
Move-Item -Force -Path $found -Destination $dest

$item.status = "done"
$item.output = "out/$($item.style)/$basename.png"
if ($ChatUrl) { $item.chat_url = $ChatUrl }
$item.completed_at = (Get-Date).ToString("o")
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 6))

# Next pending index
$next = -1
for ($k = 0; $k -lt $manifest.items.Count; $k++) {
  if ($manifest.items[$k].status -eq "pending") { $next = $k; break }
}
Write-Output "OK index=$Index saved=$dest next=$next"
