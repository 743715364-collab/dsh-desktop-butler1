# J.A.R.V.I.S. — write the model API key into jarvis-config.json.
#
# The key is read with Read-Host -AsSecureString, so it never appears on screen,
# in shell history, or in a chat transcript. Everything else in the config file
# is preserved.
#
#   .\tools\set-key.ps1                       interactive, verifies afterwards
#   .\tools\set-key.ps1 -SkipCheck            write only
#   .\tools\set-key.ps1 -BaseUrl ... -Model ...   switch provider in one go
param(
  [string]$Key = '',
  [string]$BaseUrl = '',
  [string]$Model = '',
  [string]$ConfigPath = '',
  [switch]$SkipCheck
)

$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
} catch {
  # console encoding is cosmetic here
}

$root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $root 'jarvis-config.json'
}

if (-not (Test-Path $ConfigPath)) {
  Write-Host "找不到配置文件：$ConfigPath" -ForegroundColor Red
  exit 1
}

if ([string]::IsNullOrWhiteSpace($Key)) {
  Write-Host ''
  Write-Host '  J.A.R.V.I.S. · 设置大模型密钥' -ForegroundColor Yellow
  Write-Host '  粘贴 API Key 后回车。输入不会显示，也不会留在任何记录里。' -ForegroundColor DarkGray
  Write-Host ''
  $secure = Read-Host -AsSecureString -Prompt '  API Key'
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $Key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}

# Stray whitespace from a copy-paste is the most common way a valid key fails.
$Key = ($Key -replace '\s', '')
if ([string]::IsNullOrWhiteSpace($Key)) {
  Write-Host '  没有输入密钥，已取消。' -ForegroundColor Red
  exit 1
}
if ($Key.Length -lt 16) {
  Write-Host '  这段太短了，不像一个完整的密钥，已取消。' -ForegroundColor Red
  exit 1
}

$json = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not [string]::IsNullOrWhiteSpace($BaseUrl)) { $json.llm.baseUrl = $BaseUrl }
if (-not [string]::IsNullOrWhiteSpace($Model)) { $json.llm.model = $Model }
$json.llm.apiKey = $Key

# UTF-8 without BOM: the loader tolerates a BOM but not every editor writes one.
$text = $json | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($ConfigPath, $text, (New-Object System.Text.UTF8Encoding $false))

Write-Host ''
Write-Host "  已写入：$ConfigPath" -ForegroundColor Green
Write-Host "  接口：$($json.llm.baseUrl)" -ForegroundColor DarkGray
Write-Host "  模型：$($json.llm.model)" -ForegroundColor DarkGray

if (-not $SkipCheck) {
  Write-Host ''
  Write-Host '  正在验证密钥……' -ForegroundColor DarkGray
  $url = $json.llm.baseUrl.TrimEnd('/') + '/chat/completions'
  $payload = @{
    model = $json.llm.model
    messages = @(@{ role = 'user'; content = 'ping' })
    max_tokens = 1
    stream = $false
  } | ConvertTo-Json -Depth 6 -Compress
  try {
    $null = Invoke-RestMethod -Uri $url -Method Post `
      -Headers @{ Authorization = "Bearer $Key"; 'Content-Type' = 'application/json' } `
      -Body ([System.Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 25
    Write-Host '  密钥有效，模型已响应。' -ForegroundColor Green
  } catch {
    $code = 0
    try { $code = [int]$_.Exception.Response.StatusCode } catch { $code = 0 }
    if ($code -eq 401 -or $code -eq 403) {
      Write-Host "  服务端拒绝了这把密钥（HTTP $code）。已经写进配置，但你最好再核对一次。" -ForegroundColor Yellow
    } elseif ($code -ge 400) {
      Write-Host "  服务端返回 HTTP $code。已经写进配置，桌宠会照常尝试。" -ForegroundColor Yellow
    } else {
      Write-Host '  连不上服务端（网络问题）。密钥已写入，联网后自然生效。' -ForegroundColor Yellow
    }
  }
}

Write-Host ''
Write-Host '  下一步：右键桌宠 → 重新载入语音配置（或重开桌宠）' -ForegroundColor Yellow
Write-Host ''
