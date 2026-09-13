$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$port = 8000
if ($args.Count -ge 1) { $port = [int]$args[0] }

$python = Join-Path $PSScriptRoot 'legacy\.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { $python = 'py' }

Write-Host ''
Write-Host '  Astra Web' -ForegroundColor Cyan
Write-Host '  Chrome에서 아래 주소를 열고 [화면 공유 시작] -> MapleStory 창 선택' -ForegroundColor DarkGray
Write-Host ''

if ($python -eq 'py') {
    & py -3 -X utf8 tools\serve.py --port $port
} else {
    & $python -X utf8 tools\serve.py --port $port
}
