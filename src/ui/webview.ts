/**
 * Webview详情面板
 *
 * 点击状态栏时弹出的详细用量信息面板
 * 展示5小时Token配额、模型使用量、MCP工具用量、重置倒计时
 */

import * as vscode from 'vscode';
import type { UsageData } from '../api/types';

export class WebviewManager {
    private panel: vscode.WebviewPanel | undefined;
    private lastData: UsageData | undefined;

    /**
     * 显示或更新详情面板
     */
    show(data: UsageData, extensionUri: vscode.Uri): void {
        this.lastData = data;

        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.One);
            this.panel.webview.html = this.getHtml(data);
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'zhipuUsage',
            '智谱用量详情',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        this.panel.webview.html = this.getHtml(data);

        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });
    }

    /**
     * 面板是否可见
     */
    isVisible(): boolean {
        return this.panel?.visible ?? false;
    }

    /**
     * 更新面板数据（如果面板打开着）
     */
    updateIfVisible(data: UsageData): void {
        this.lastData = data;
        if (this.panel) {
            this.panel.webview.html = this.getHtml(data);
        }
    }

    /**
     * 格式化数字为千分位形式
     */
    private fmtNum(num: number | undefined): string {
        if (num === undefined) { return '-'; }
        return num.toLocaleString('en-US');
    }

    /**
     * 生成重置倒计时文本
     */
    private getResetCountdown(resetTime: number | undefined): string {
        if (!resetTime) { return '未知'; }
        const now = Date.now();
        const diff = resetTime - now;
        if (diff <= 0) { return '即将重置'; }

        const hours = Math.floor(diff / 3600000);
        const minutes = Math.floor((diff % 3600000) / 60000);
        return `${hours}小时${minutes}分钟后`;
    }

    /**
     * 根据百分比返回颜色
     */
    private getColor(pct: number): string {
        if (pct >= 85) { return '#f44336'; }
        if (pct >= 60) { return '#ff9800'; }
        return '#4caf50';
    }

    /**
     * 生成完整HTML页面
     */
    private getHtml(data: UsageData): string {
        const pct = Math.round(data.tokenPercentage);
        const color = this.getColor(pct);
        const resetText = this.getResetCountdown(data.nextResetTime);
        const planText = data.planLevel
            ? data.planLevel.charAt(0).toUpperCase() + data.planLevel.slice(1).toLowerCase()
            : '未知';

        return /*html*/`<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>智谱用量详情</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            padding: 20px;
            line-height: 1.6;
        }
        .header {
            text-align: center;
            margin-bottom: 24px;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--vscode-widget-border, #333);
        }
        .header h1 {
            font-size: 20px;
            font-weight: 600;
            margin-bottom: 4px;
        }
        .header .meta {
            font-size: 12px;
            opacity: 0.7;
        }
        .plan-badge {
            display: inline-block;
            padding: 2px 10px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
            background: var(--vscode-badge-background, #333);
            color: var(--vscode-badge-foreground, #fff);
            margin-left: 8px;
        }

        /* 圆形进度 */
        .progress-ring-container {
            display: flex;
            justify-content: center;
            margin: 20px 0;
        }
        .progress-ring {
            position: relative;
            width: 160px;
            height: 160px;
        }
        .progress-ring svg {
            transform: rotate(-90deg);
        }
        .progress-ring circle {
            fill: none;
            stroke-width: 12;
            stroke-linecap: round;
        }
        .progress-ring .bg {
            stroke: var(--vscode-widget-border, #2a2a2a);
        }
        .progress-ring .fg {
            stroke: ${color};
            transition: stroke-dashoffset 0.5s ease;
        }
        .progress-center {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            text-align: center;
        }
        .progress-pct {
            font-size: 36px;
            font-weight: 700;
            color: ${color};
        }
        .progress-label {
            font-size: 12px;
            opacity: 0.7;
        }

        /* 卡片 */
        .cards {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
            margin: 20px 0;
        }
        .card {
            background: var(--vscode-input-background, #1e1e1e);
            border: 1px solid var(--vscode-widget-border, #333);
            border-radius: 8px;
            padding: 14px;
        }
        .card.full { grid-column: 1 / -1; }
        .card-title {
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
            opacity: 0.6;
            margin-bottom: 8px;
            letter-spacing: 0.5px;
        }
        .card-value {
            font-size: 22px;
            font-weight: 700;
        }
        .card-sub {
            font-size: 12px;
            opacity: 0.6;
            margin-top: 2px;
        }

        /* 进度条 */
        .bar-bg {
            width: 100%;
            height: 6px;
            background: var(--vscode-widget-border, #2a2a2a);
            border-radius: 3px;
            margin-top: 8px;
            overflow: hidden;
        }
        .bar-fill {
            height: 100%;
            border-radius: 3px;
            transition: width 0.5s ease;
        }
        .footer {
            text-align: center;
            font-size: 11px;
            opacity: 0.5;
            margin-top: 20px;
            padding-top: 12px;
            border-top: 1px solid var(--vscode-widget-border, #333);
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>智谱 AI 用量监控 <span class="plan-badge">${planText}</span></h1>
        <div class="meta">查询时间: ${data.queryTime}</div>
    </div>

    <!-- 圆形进度 -->
    <div class="progress-ring-container">
        <div class="progress-ring">
            <svg width="160" height="160">
                <circle class="bg" cx="80" cy="80" r="68"/>
                <circle class="fg" cx="80" cy="80" r="68"
                    stroke-dasharray="${2 * Math.PI * 68}"
                    stroke-dashoffset="${2 * Math.PI * 68 * (1 - pct / 100)}"/>
            </svg>
            <div class="progress-center">
                <div class="progress-pct">${pct}%</div>
                <div class="progress-label">5小时配额</div>
            </div>
        </div>
    </div>

    <!-- 配额数据卡片 -->
    <div class="cards">
        <div class="card">
            <div class="card-title">已用 Token</div>
            <div class="card-value">${this.fmtNum(data.tokenUsed)}</div>
            <div class="card-sub">总量: ${this.fmtNum(data.tokenTotal)}</div>
        </div>
        <div class="card">
            <div class="card-title">重置倒计时</div>
            <div class="card-value" style="font-size:18px;">${resetText}</div>
            <div class="card-sub">每5小时重置</div>
        </div>

        ${data.mcpPercentage !== undefined ? `
        <div class="card full">
            <div class="card-title">MCP 月度配额</div>
            <div class="card-value">${Math.round(data.mcpPercentage)}%</div>
            <div class="card-sub">
                ${data.mcpCurrentValue !== undefined ? `已用: ${this.fmtNum(data.mcpCurrentValue)}` : ''}
                ${data.mcpTotal !== undefined ? ` / 总量: ${this.fmtNum(data.mcpTotal)}` : ''}
            </div>
            <div class="bar-bg">
                <div class="bar-fill" style="width:${Math.min(data.mcpPercentage, 100)}%;background:${this.getColor(data.mcpPercentage)};"></div>
            </div>
        </div>
        ` : ''}

        <div class="card">
            <div class="card-title">24h 模型调用</div>
            <div class="card-value">${this.fmtNum(data.modelCallCount)}</div>
            <div class="card-sub">Token: ${this.fmtNum(data.modelTokensUsage)}</div>
        </div>
        <div class="card">
            <div class="card-title">24h 网络搜索</div>
            <div class="card-value">${this.fmtNum(data.networkSearchCount)}</div>
            <div class="card-sub">Web读取: ${this.fmtNum(data.webReadCount)}</div>
        </div>
    </div>

    <div class="footer">
        智谱用量监控插件 v0.1.0 · 数据来源 open.bigmodel.cn
    </div>
</body>
</html>`;
    }

    dispose(): void {
        this.panel?.dispose();
    }
}
