$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) {
    py -3 -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Python 가상 환경 생성 실패' }
}
& .\.venv\Scripts\python.exe -m pip install -r requirements.lock
if ($LASTEXITCODE -ne 0) { throw '의존성 설치 실패' }
& .\.venv\Scripts\python.exe -m pip install -e . --no-deps
if ($LASTEXITCODE -ne 0) { throw '프로젝트 설치 실패' }
