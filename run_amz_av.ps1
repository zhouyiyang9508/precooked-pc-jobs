$ErrorActionPreference = 'Stop'
$dir = 'D:\hermes_cache\amazon_av'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$raw = 'https://raw.githubusercontent.com/zhouyiyang9508/precooked-pc-jobs/master'
foreach ($f in @('asins.txt', 'amz_av.mjs', 'compact.mjs')) {
  if (-not (Test-Path "$dir\$f")) {
    Invoke-WebRequest -UseBasicParsing "$raw/$f" -OutFile "$dir\$f" -UserAgent 'Mozilla/5.0' -TimeoutSec 120
  }
}
Write-Output ("asins=" + ((Get-Content "$dir\asins.txt" | Measure-Object -Line).Lines))

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
& $node "$dir\amz_av.mjs" $dir 2>&1 | Select-Object -Last 8
Write-Output '---RESULT---'
& $node "$dir\compact.mjs" "$dir\av.jsonl"
