# J.A.R.V.I.S. — media transport over SMTC (GlobalSystemMediaTransportControls).
#
# Actions: status | play_pause | next | previous
# Prints one line of UTF-8 JSON:
#   {"ok":true,"app":"...","title":"...","artist":"...","status":"Playing","via":"smtc"}
#
# SMTC is what turns "send a media key" into "know what is playing and control
# that specific session". When no player exposes a session we fall back to the
# global media keys, which every player honours anyway.
param(
  [ValidateSet('status', 'play_pause', 'next', 'previous')][string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
} catch {
  # ASCII JSON still works
}

function Send-Json($value) {
  Write-Output ($value | ConvertTo-Json -Compress -Depth 4)
  exit 0
}

function Send-MediaKey([int]$code) {
  $shell = New-Object -ComObject WScript.Shell
  $shell.SendKeys([char]$code)
}

$result = @{ ok = $false; app = ''; title = ''; artist = ''; status = ''; via = '' }

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and
      $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

  function Await($operation, $type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
    $task.Wait(-1) | Out-Null
    return $task.Result
  }

  [void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $sessions = @($manager.GetSessions())

  if ($sessions.Count -gt 0) {
    # Prefer whatever is actually playing; otherwise take the first session.
    $session = $sessions | Where-Object { [string]$_.GetPlaybackInfo().PlaybackStatus -eq 'Playing' } | Select-Object -First 1
    if (-not $session) { $session = $sessions[0] }

    $result.app = [string]$session.SourceAppUserModelId
    $result.status = [string]$session.GetPlaybackInfo().PlaybackStatus
    $result.via = 'smtc'

    try {
      $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $result.title = [string]$props.Title
      $result.artist = [string]$props.Artist
    } catch {
      # Track metadata is optional.
    }

    switch ($Action) {
      'play_pause' { $result.ok = [bool](Await ($session.TryTogglePlayPauseAsync()) ([bool])) }
      'next' { $result.ok = [bool](Await ($session.TrySkipNextAsync()) ([bool])) }
      'previous' { $result.ok = [bool](Await ($session.TrySkipPreviousAsync()) ([bool])) }
      default { $result.ok = $true }
    }

    if ($Action -ne 'status') {
      Start-Sleep -Milliseconds 280
      $result.status = [string]$session.GetPlaybackInfo().PlaybackStatus
    }
  }
} catch {
  # Fall through to the media-key path below.
}

if (-not $result.ok -and $Action -ne 'status') {
  switch ($Action) {
    'play_pause' { Send-MediaKey 179; $result.ok = $true }
    'next' { Send-MediaKey 176; $result.ok = $true }
    'previous' { Send-MediaKey 177; $result.ok = $true }
  }
  $result.via = 'keys'
}

Send-Json $result
