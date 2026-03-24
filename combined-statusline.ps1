# Combined StatusLine Script - 三行模式
# 第1行: ccline (模型、目录、上下文使用率)
# 第2行: GLM会话 (会话数、今日/本月用量)
# 第3行: GLM配额 (5小时限制、MCP额度、重置倒计时)

$cclineOutput = ""
$glmOutput = ""

# Run ccline.exe
try {
    $cclineOutput = & "$env:USERPROFILE\.claude\ccline\ccline.exe" 2>$null
    # 移除 Context 显示（如 "Context ░░░░░░░░0% (0)"）
    $cclineOutput = $cclineOutput -replace '\s*Context\s+[░█]+\s*\d+%\s*\(\d+\)', ''
} catch {
    $cclineOutput = ""
}

# Run GLM usage
try {
    $glmOutput = & npx @wangjs-jacky/glm-coding-plan-statusline@latest 2>$null
} catch {
    $glmOutput = ""
}

# Helper function to clean GLM output
function Clean-GlmSession {
    param([string]$line)
    # 移除 Sess:数字 及其周围的 ANSI 颜色码（如 "[2mSess:0[0m"）
    $line = $line -replace '(\x1b\[[0-9;]*m)?\s*Sess:\d+(\x1b\[[0-9;]*m)?', ''
    # 清理连续的分隔符（移除 Sess 后可能留下的空隙，如 "│ │" 或 "│ [2m[0m │"）
    $line = $line -replace '\s*│(\s*\x1b\[[0-9;]*m)*\s*│\s*', ' │ '
    return $line
}

function Clean-GlmQuota {
    param([string]$line)
    # 移除 Context 显示（使用宽松正则忽略 ANSI 颜色码干扰）
    # 匹配: 可选的 │ + 任意内容(含ANSI码) + Context + 任意内容 + (数字)
    $line = $line -replace '\s*│[^C]*Context.*?\(\d+\)', ''
    # 追加重置倒计时
    $countdown = Get-ResetCountdown
    if ($countdown) {
        $line = "$line │ $countdown"
    }
    return $line
}

# ANSI 转义前缀（兼容 PS5，不使用 `e）
$script:ESC = [char]27

# 从智谱API获取精确的 nextResetTime，计算重置倒计时
function Get-ResetCountdown {
    try {
        # 从 VS Code settings.json 用正则提取 API Key（避免 PS5 JSON 解析兼容问题）
        $settingsPath = "$env:APPDATA\Code\User\settings.json"
        if (-not (Test-Path $settingsPath)) { return "" }
        $raw = Get-Content $settingsPath -Raw
        if ($raw -match '"zhipu\.apiKey"\s*:\s*"([^"]+)"') {
            $apiKey = $Matches[1]
        } else {
            return ""
        }

        # 调用智谱配额限制API
        $uri = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'
        $headers = @{
            'Authorization' = $apiKey
            'Accept-Language' = 'zh-CN,zh'
            'Content-Type' = 'application/json'
        }
        $response = Invoke-RestMethod -Uri $uri -Headers $headers -Method Get -TimeoutSec 5

        # 从 TOKENS_LIMIT 中提取 nextResetTime
        $nextResetTime = $null
        if ($response.data -and $response.data.limits) {
            foreach ($limit in $response.data.limits) {
                if ($limit.type -eq 'TOKENS_LIMIT' -and $limit.nextResetTime) {
                    $nextResetTime = $limit.nextResetTime
                    break
                }
            }
        }

        if (-not $nextResetTime) { return "" }

        # 计算倒计时（nextResetTime 是 Unix 毫秒时间戳）
        $nowMs = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
        $diffMs = $nextResetTime - $nowMs

        if ($diffMs -le 0) {
            return "$($script:ESC)[32m⏳ 已重置$($script:ESC)[0m"
        }

        $diffMinutes = [int][math]::Floor($diffMs / 60000)
        $hours = [int][math]::Floor($diffMinutes / 60)
        $minutes = [int]($diffMinutes % 60)

        # 根据剩余时间选择颜色
        if ($diffMinutes -gt 180) {
            $color = "$($script:ESC)[32m"   # 绿色 > 3h
        } elseif ($diffMinutes -gt 60) {
            $color = "$($script:ESC)[33m"   # 黄色 1-3h
        } else {
            $color = "$($script:ESC)[31m"   # 红色 < 1h
        }
        $reset = "$($script:ESC)[0m"
        return "${color}⏳ ${hours}h$($minutes.ToString('D2'))m${reset}"
    } catch {
        return ""
    }
}

# Combine outputs with newline for three-line display
if ($cclineOutput -and $glmOutput) {
    # GLM 包输出两行，全部保留
    $glmLines = $glmOutput -split "`n" | Where-Object { $_.Trim() -ne "" }
    $glmSession = if ($glmLines.Count -ge 1) { Clean-GlmSession $glmLines[0] } else { "" }
    $glmQuota = if ($glmLines.Count -ge 2) { Clean-GlmQuota $glmLines[1] } else { "" }
    if ($glmQuota) {
        Write-Output "$cclineOutput`n$glmSession`n$glmQuota"
    } else {
        Write-Output "$cclineOutput`n$glmSession"
    }
} elseif ($cclineOutput) {
    Write-Output $cclineOutput
} elseif ($glmOutput) {
    $glmLines = $glmOutput -split "`n" | Where-Object { $_.Trim() -ne "" }
    $glmSession = if ($glmLines.Count -ge 1) { Clean-GlmSession $glmLines[0] } else { "" }
    $glmQuota = if ($glmLines.Count -ge 2) { Clean-GlmQuota $glmLines[1] } else { "" }
    if ($glmQuota) {
        Write-Output "$glmSession`n$glmQuota"
    } else {
        Write-Output $glmSession
    }
}
