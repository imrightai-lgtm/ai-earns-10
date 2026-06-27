# photo_server.ps1 - HTTP listener; serves ONE image with CORS *, responds to /stop.
# Run ONLY via Bash run_in_background: true (not Start-Process).
#   powershell -NoProfile -ExecutionPolicy Bypass -File photo_server.ps1 -ImagePath "<abs>" -Port 8765
# Reconstructed from IMAGE_GEN_PLAYBOOK.md - verify on first run. ASCII-only for Windows PowerShell 5.1.
param(
  [Parameter(Mandatory = $true)][string]$ImagePath,
  [int]$Port = 8765
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path $ImagePath)) { Write-Error "Image not found: $ImagePath"; exit 1 }
$bytes = [System.IO.File]::ReadAllBytes($ImagePath)
$ext = [System.IO.Path]::GetExtension($ImagePath).ToLower()
$ctype = switch ($ext) { ".png" { "image/png" } ".webp" { "image/webp" } ".gif" { "image/gif" } default { "image/jpeg" } }

$listener = New-Object System.Net.HttpListener
$prefix = "http://127.0.0.1:$Port/"
$listener.Prefixes.Add($prefix)
$listener.Start()
Write-Output "LISTENING on $prefix"
try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $res = $ctx.Response
    $res.Headers.Add("Access-Control-Allow-Origin", "*")
    if ($ctx.Request.Url.AbsolutePath -eq "/stop") {
      $b = [System.Text.Encoding]::UTF8.GetBytes("stopping")
      $res.OutputStream.Write($b, 0, $b.Length); $res.Close()
      break
    }
    $res.ContentType = $ctype
    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
    $res.Close()
  }
}
finally {
  $listener.Stop(); $listener.Close()
}
