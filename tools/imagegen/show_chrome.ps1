# show_chrome.ps1 - raise Chrome windows to foreground (to allow a permission prompt).
#   powershell -NoProfile -ExecutionPolicy Bypass -File show_chrome.ps1
# Reconstructed from IMAGE_GEN_PLAYBOOK.md - verify on first run. ASCII-only for Windows PowerShell 5.1.
$ErrorActionPreference = "SilentlyContinue"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$procs = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
foreach ($p in $procs) {
  [Win]::ShowWindow($p.MainWindowHandle, 9) | Out-Null   # SW_RESTORE
  [Win]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
}
Write-Output "Chrome windows raised: $($procs.Count)"
