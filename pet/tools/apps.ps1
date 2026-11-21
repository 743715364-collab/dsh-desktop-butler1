# J.A.R.V.I.S. — appended-app index and window control.
#
# Modes:
#   -Mode list                      installed Start-menu apps as JSON
#   -Mode launch -Target <id> [-Kind exe|lnk|aumid]
#   -Mode windows                   windowed processes as JSON
#   -Mode close -ProcId <pid>       graceful WM_CLOSE (never TerminateProcess)
#   -Mode league-exit -ProcId <pid>  bring the League client forward and request
#                                    its own exit confirmation (anti-cheat blocks
#                                    synthetic clicks and process termination)
#
# Every mode prints exactly one line of UTF-8 JSON.
param(
  [Parameter(Mandatory = $true)][ValidateSet('list', 'launch', 'windows', 'close', 'league-exit')][string]$Mode,
  [string]$Target = '',
  [ValidateSet('exe', 'lnk', 'aumid')][string]$Kind = 'aumid',
  [int]$ProcId = 0
)

$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
} catch {
  # keep going; ASCII JSON survives either way
}

function Send-Json($value) {
  Write-Output ($value | ConvertTo-Json -Compress -Depth 4)
  exit 0
}

try {
  switch ($Mode) {
    'list' {
      $items = New-Object System.Collections.ArrayList
      $seen = @{}

      # Desktop apps and packaged (UWP) apps, keyed by executable path or AUMID.
      Get-StartApps -ErrorAction SilentlyContinue | ForEach-Object {
        $name = $_.Name
        $id = $_.AppID
        if (-not [string]::IsNullOrWhiteSpace($name) -and -not [string]::IsNullOrWhiteSpace($id)) {
          $key = ($name + '|' + $id).ToLower()
          if (-not $seen.ContainsKey($key)) {
            $seen[$key] = 1
            [void]$items.Add(@{ name = [string]$name; id = [string]$id })
          }
        }
      }

      # Shortcut names catch apps that never register in the Start menu index.
      $menus = @(
        (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),
        (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
      )
      foreach ($menu in $menus) {
        if (-not (Test-Path $menu)) { continue }
        Get-ChildItem $menu -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
          $name = $_.BaseName
          if (-not [string]::IsNullOrWhiteSpace($name)) {
            $key = ($name + '|' + $_.FullName).ToLower()
            if (-not $seen.ContainsKey($key)) {
              $seen[$key] = 1
              [void]$items.Add(@{ name = [string]$name; id = [string]$_.FullName })
            }
          }
        }
      }

      Send-Json @($items)
    }

    'launch' {
      if ([string]::IsNullOrWhiteSpace($Target)) { Send-Json @{ ok = $false; error = 'empty target' } }
      switch ($Kind) {
        'exe' { Start-Process -FilePath $Target; Send-Json @{ ok = $true } }
        'lnk' { Start-Process -FilePath $Target; Send-Json @{ ok = $true } }
        default {
          # Packaged app: the shell: protocol is the documented launcher.
          Start-Process -FilePath 'explorer.exe' -ArgumentList ('shell:AppsFolder\' + $Target)
          Send-Json @{ ok = $true }
        }
      }
    }

    'windows' {
      $list = @()
      Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.MainWindowHandle -ne 0 -and -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle)) {
          $list += @{ pid = $_.Id; process = [string]$_.ProcessName; title = [string]$_.MainWindowTitle }
        }
      }
      Send-Json @($list)
    }

    'close' {
      if ($ProcId -le 0) { Send-Json @{ ok = $false; error = 'no pid' } }
      $proc = Get-Process -Id $ProcId -ErrorAction Stop
      $closed = $proc.CloseMainWindow()
      Send-Json @{ ok = [bool]$closed; process = [string]$proc.ProcessName }
    }

    'league-exit' {
      # The League client is anti-cheat protected: WM_CLOSE/Alt+F4 and synthetic
      # clicks are ignored, and TerminateProcess is access-denied. The supported
      # route is its own "现在退出吗？" panel, so bring it forward and request it.
      if ($ProcId -le 0) { Send-Json @{ ok = $false; error = 'no pid' } }
      $proc = Get-Process -Id $ProcId -ErrorAction Stop
      $handle = $proc.MainWindowHandle
      $activated = $false
      if ($handle -ne 0) {
        Add-Type @'
using System;
using System.Runtime.InteropServices;
public class JarvisLeagueExit {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
'@
        [JarvisLeagueExit]::ShowWindow($handle, 9) | Out-Null
        $activated = [JarvisLeagueExit]::SetForegroundWindow($handle)
        [JarvisLeagueExit]::PostMessage($handle, 0x0112, [IntPtr]0xF060, [IntPtr]::Zero) | Out-Null
      }
      Start-Sleep -Milliseconds 900
      $alive = $null -ne (Get-Process -Id $ProcId -ErrorAction SilentlyContinue)
      Send-Json @{ ok = $true; alive = $alive; activated = [bool]$activated }
    }
  }
} catch {
  Send-Json @{ ok = $false; error = $_.Exception.Message }
}
