$ErrorActionPreference = 'Stop'
$dir = 'D:\hermes_cache\amazon_av_pc'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$raw = 'https://raw.githubusercontent.com/zhouyiyang9508/precooked-pc-jobs/master'
foreach ($f in @('asins_todo.txt', 'amz_cdp.mjs', 'compact.mjs')) {
  if (-not (Test-Path "$dir\$f")) {
    Invoke-WebRequest -UseBasicParsing "$raw/$f" -OutFile "$dir\$f" -UserAgent 'Mozilla/5.0' -TimeoutSec 120
  }
}
Copy-Item "$dir\asins_todo.txt" "$dir\asins.txt" -Force
Write-Output ("asins=" + ((Get-Content "$dir\asins.txt" | Measure-Object -Line).Lines))

$chrome = @(
  'C:\Program Files\Google\Chrome\Application\chrome.exe',
  'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { Write-Output 'chrome not found'; exit 2 }
Write-Output "chrome=$chrome"

$profile = Join-Path $dir 'profile'
$cargs = @(
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-blink-features=AutomationControlled',
  '--remote-debugging-port=9333', "--user-data-dir=$profile", 'about:blank'
)
$null = Start-Process -FilePath $chrome -ArgumentList $cargs -PassThru -WindowStyle Hidden
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  try { $v = Invoke-RestMethod -Uri 'http://127.0.0.1:9333/json/version' -TimeoutSec 3; $ok = $true; break } catch { }
}
if (-not $ok) { Write-Output 'cdp not ready'; exit 3 }
Write-Output ("browser=" + $v.Browser)

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
$env:CDP_PORT = '9333'
$env:SLEEP_LO = '1200'
$env:SLEEP_HI = '2600'
& $node "$dir\amz_cdp.mjs" $dir 2 2>&1 | Select-Object -Last 6

Write-Output '---RESULT---'
if (Test-Path "$dir\av.jsonl") { & $node "$dir\compact.mjs" "$dir\av.jsonl" }

Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -like '*amazon_av_pc*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
