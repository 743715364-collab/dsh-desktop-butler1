# J.A.R.V.I.S. offline speech recognition bridge.
#
# Usage:
#   powershell -NoProfile -File sapi-asr.ps1 -Wav <path.wav> [-Culture zh-CN] [-Phrases '["..."]']
#
# Prints exactly one line of UTF-8 JSON:
#   {"ok":true,"text":"...","confidence":0.87}
#   {"ok":false,"reason":"silence"}      the clip held no recognisable speech
#   {"ok":false,"error":"..."}           the bridge itself failed
#
# Uses System.Speech, i.e. the recogniser that ships with Windows — no network,
# no API key. Accuracy is well below a cloud model, so it is the fallback, not
# the default. Recorded audio must be 16 kHz / mono / 16-bit PCM WAV.
param(
  [Parameter(Mandatory = $true)][string]$Wav,
  [string]$Culture = 'zh-CN',
  [string]$Phrases = '[]'
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 writes the OEM code page by default, which garbles
# Chinese on the Node side. Force UTF-8 for everything this script emits.
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
} catch {
  # Older hosts may refuse; the JSON still round-trips as long as it is ASCII.
}

function Send-Result($result) {
  Write-Output ($result | ConvertTo-Json -Compress -Depth 4)
  exit 0
}

try {
  Add-Type -AssemblyName System.Speech

  $engine = $null
  try {
    $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine (New-Object System.Globalization.CultureInfo $Culture)
  } catch {
    # Requested culture has no recogniser: fall back to whatever is installed.
    $info = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Select-Object -First 1
    if (-not $info) {
      Send-Result @{ ok = $false; error = 'no recogniser installed' }
    }
    $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine $info
  }

  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))

  # Optional exact-phrase grammar. Off by default: a narrow grammar can win over
  # free dictation and mis-hear an ordinary sentence as a command.
  $list = @()
  try {
    $list = @(ConvertFrom-Json -InputObject $Phrases)
  } catch {
    $list = @()
  }
  $list = @($list | Where-Object { $_ -is [string] -and $_.Trim().Length -gt 0 })
  if ($list.Count -gt 0) {
    $choices = New-Object System.Speech.Recognition.Choices
    $choices.Add([string[]]$list)
    $builder = New-Object System.Speech.Recognition.GrammarBuilder
    $builder.Append($choices)
    $grammar = New-Object System.Speech.Recognition.Grammar $builder
    $grammar.Name = 'commands'
    $engine.LoadGrammar($grammar)
  }

  $engine.SetInputToWaveFile($Wav)

  # Keep the most confident hit across the whole clip instead of the first.
  $best = $null
  while ($true) {
    $hit = $engine.Recognize()
    if ($null -eq $hit) { break }
    if ($null -eq $best -or $hit.Confidence -gt $best.Confidence) { $best = $hit }
  }
  $engine.Dispose()

  if ($null -eq $best) {
    Send-Result @{ ok = $false; reason = 'silence' }
  }
  Send-Result @{ ok = $true; text = $best.Text; confidence = [double]$best.Confidence }
} catch {
  Send-Result @{ ok = $false; error = $_.Exception.Message }
}
