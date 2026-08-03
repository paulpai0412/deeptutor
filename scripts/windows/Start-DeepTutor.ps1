$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'DeepTutor 服務啟動器'
$url = 'http://localhost:3782'
$wslExe = Join-Path $env:WINDIR 'System32\wsl.exe'
$wslArgs = @(
    '-d', 'Ubuntu',
    '-u', 'timmypai',
    '--', '/home/timmypai/apps/DeepTutor/scripts/wsl/restart_deeptutor.sh'
)

Clear-Host
Write-Host '========================================' -ForegroundColor Cyan
Write-Host ' DeepTutor 服務啟動器' -ForegroundColor Cyan
Write-Host '========================================' -ForegroundColor Cyan
Write-Host '[1/3] 正在停止既有 DeepTutor 服務...' -ForegroundColor Yellow
Write-Host '[2/3] 正在 WSL 中啟動後端與前端...' -ForegroundColor Yellow
Write-Host ''

try {
    $process = Start-Process -FilePath $wslExe -ArgumentList $wslArgs -NoNewWindow -PassThru
    $ready = $false

    for ($second = 1; $second -le 90; $second++) {
        if ($process.HasExited) {
            throw "WSL 啟動程序提前結束，Exit Code：$($process.ExitCode)"
        }

        try {
            $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 1
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
                $ready = $true
                break
            }
        } catch {
            # 服務尚未就緒，繼續等待。
        }

        $percent = [Math]::Min(99, [Math]::Round(($second / 90) * 100))
        Write-Progress -Activity '啟動 DeepTutor' -Status "等待前端服務... ${second}s / 90s" -PercentComplete $percent
        Start-Sleep -Seconds 1
    }

    Write-Progress -Activity '啟動 DeepTutor' -Completed
    if (-not $ready) {
        throw '等待 90 秒後，DeepTutor 前端仍未回應。'
    }

    Write-Host ''
    Write-Host '[3/3] DeepTutor 已啟動完成！' -ForegroundColor Green
    Write-Host "網址：$url" -ForegroundColor Green
    Write-Host '現在可以點擊桌面的「開啟 DeepTutor」。' -ForegroundColor White
    Write-Host ''
    Write-Host '請保持此視窗開啟以查看即時日誌。' -ForegroundColor DarkGray

    Wait-Process -Id $process.Id
    Write-Host ''
    Write-Host "DeepTutor 服務已停止，Exit Code：$($process.ExitCode)" -ForegroundColor Yellow
    Read-Host '按 Enter 關閉視窗'
} catch {
    Write-Progress -Activity '啟動 DeepTutor' -Completed
    Write-Host ''
    Write-Host "啟動失敗：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'WSL 日誌：~/.local/state/deeptutor/restart.log' -ForegroundColor Yellow
    Read-Host '按 Enter 關閉視窗'
    exit 1
}
