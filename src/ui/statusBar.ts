/**
 * 状态栏管理模块
 * 
 * 在VSCode状态栏显示智谱用量概览
 * 格式: $(cloud) GLM: 45% | 18M/40M
 * 悬停显示Markdown富文本用量详情
 * 颜色根据用量比例变化：绿色(<60%) → 黄色(60-85%) → 红色(>85%)
 */

import * as vscode from 'vscode';
import type { UsageData } from '../api/types';

export class StatusBarManager {
    private statusBarItem: vscode.StatusBarItem;

    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.statusBarItem.command = 'zhipu.showDetails';
        this.statusBarItem.tooltip = '点击查看智谱用量详情';
        this.statusBarItem.text = '$(cloud) GLM: 加载中...';
        this.statusBarItem.show();
    }

    /**
     * 格式化数字为简短形式 (例: 18,000,000 → 18M)
     */
    private formatNumber(num: number): string {
        if (num >= 1_000_000_000) {
            return (num / 1_000_000_000).toFixed(1) + 'B';
        }
        if (num >= 1_000_000) {
            return (num / 1_000_000).toFixed(1) + 'M';
        }
        if (num >= 1_000) {
            return (num / 1_000).toFixed(1) + 'K';
        }
        return num.toString();
    }

    /**
     * 格式化千分位数字
     */
    private fmtNum(num: number | undefined): string {
        if (num === undefined) { return '-'; }
        return num.toLocaleString('en-US');
    }

    /**
     * 生成进度条文本 (用Unicode方块字符)
     */
    private makeProgressBar(pct: number, length: number = 20): string {
        const filled = Math.round((pct / 100) * length);
        const empty = length - filled;
        return '█'.repeat(filled) + '░'.repeat(empty);
    }

    /**
     * 生成重置倒计时文本
     */
    private getResetCountdown(resetTime: number | undefined): string {
        if (!resetTime) { return '未知'; }
        const diff = resetTime - Date.now();
        if (diff <= 0) { return '即将重置'; }
        const hours = Math.floor(diff / 3600000);
        const minutes = Math.floor((diff % 3600000) / 60000);
        return `${hours}h ${minutes}m`;
    }

    /**
     * 生成Markdown悬停提示
     */
    private buildTooltip(data: UsageData): vscode.MarkdownString {
        const pct = Math.round(data.tokenPercentage);
        const resetText = this.getResetCountdown(data.nextResetTime);
        const planText = data.planLevel
            ? data.planLevel.charAt(0).toUpperCase() + data.planLevel.slice(1).toLowerCase()
            : '';

        // 状态图标
        const statusIcon = pct >= 85 ? '🔴' : pct >= 60 ? '🟡' : '🟢';

        const lines: string[] = [];

        // 标题
        lines.push(`**$(cloud) 智谱 AI 用量监控**${planText ? ` · ${planText}` : ''}`);
        lines.push('');
        lines.push('---');
        lines.push('');

        // 5小时Token配额
        lines.push(`${statusIcon} **5小时 Token 配额**`);
        lines.push('');
        lines.push(`\`${this.makeProgressBar(pct)}\` **${pct}%**`);
        lines.push('');
        lines.push(`已用 **${this.fmtNum(data.tokenUsed)}** / 总量 **${this.fmtNum(data.tokenTotal)}**`);
        lines.push('');
        lines.push(`$(clock) 重置倒计时: **${resetText}**`);

        // 周限额（新套餐 Coding Plan 独有）
        if (data.weeklyPercentage !== undefined) {
            const wp = Math.round(data.weeklyPercentage);
            const weekStatusIcon = wp >= 85 ? '🔴' : wp >= 60 ? '🟡' : '🟢';
            const weekResetText = this.getResetCountdown(data.weeklyNextResetTime);
            lines.push('');
            lines.push('---');
            lines.push('');
            lines.push(`${weekStatusIcon} **📅 周限额**`);
            lines.push('');
            lines.push(`\`${this.makeProgressBar(wp)}\` **${wp}%**`);
            lines.push('');
            lines.push(`$(clock) 周重置倒计时: **${weekResetText}**`);
        }

        // MCP月度配额
        if (data.mcpPercentage !== undefined) {
            const mcpPct = Math.round(data.mcpPercentage);
            lines.push('');
            lines.push('---');
            lines.push('');
            lines.push(`📦 **MCP 月度配额** — **${mcpPct}%**`);
            lines.push('');
            lines.push(`\`${this.makeProgressBar(mcpPct)}\``);
            if (data.mcpCurrentValue !== undefined && data.mcpTotal !== undefined) {
                lines.push('');
                lines.push(`已用 **${this.fmtNum(data.mcpCurrentValue)}** / 总量 **${this.fmtNum(data.mcpTotal)}**`);
            }
        }

        // 24h统计
        lines.push('');
        lines.push('---');
        lines.push('');
        lines.push('**24 小时统计**');
        lines.push('');
        lines.push(`| 指标 | 数值 |`);
        lines.push(`|:--|--:|`);
        lines.push(`| $(symbol-method) 模型调用 | ${this.fmtNum(data.modelCallCount)} 次 |`);
        lines.push(`| $(symbol-key) Token 消耗 | ${this.fmtNum(data.modelTokensUsage)} |`);
        lines.push(`| $(search) 网络搜索 | ${this.fmtNum(data.networkSearchCount)} 次 |`);
        lines.push(`| $(globe) Web 读取 | ${this.fmtNum(data.webReadCount)} 次 |`);

        // 底部
        lines.push('');
        lines.push('---');
        lines.push('');
        lines.push(`$(info) ${data.queryTime} · *点击查看详情*`);

        const md = new vscode.MarkdownString(lines.join('\n'), true);
        md.isTrusted = true;
        md.supportThemeIcons = true;
        return md;
    }

    /**
     * 更新状态栏显示
     */
    update(data: UsageData, keyName?: string): void {
        const pct = Math.round(data.tokenPercentage);
        const used = this.formatNumber(data.tokenUsed);
        const total = this.formatNumber(data.tokenTotal);
        const nameTag = keyName ? `[${keyName}] ` : '';

        // 如果有周限额，在状态栏也显示
        let weeklyTag = '';
        if (data.weeklyPercentage !== undefined) {
            weeklyTag = ` W:${Math.round(data.weeklyPercentage)}%`;
        }

        this.statusBarItem.text = `$(cloud) ${nameTag}GLM: ${pct}%${weeklyTag} | ${used}/${total}`;
        this.statusBarItem.tooltip = this.buildTooltip(data);

        // 根据用量百分比设置颜色（取5h和周限额中较高的）
        const maxPct = Math.max(pct, data.weeklyPercentage ?? 0);
        if (maxPct >= 85) {
            this.statusBarItem.backgroundColor = new vscode.ThemeColor(
                'statusBarItem.errorBackground'
            );
        } else if (maxPct >= 60) {
            this.statusBarItem.backgroundColor = new vscode.ThemeColor(
                'statusBarItem.warningBackground'
            );
        } else {
            this.statusBarItem.backgroundColor = undefined;
        }
    }

    /**
     * 显示错误状态
     */
    showError(message: string): void {
        this.statusBarItem.text = '$(cloud) GLM: $(warning) 错误';
        this.statusBarItem.tooltip = message;
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
            'statusBarItem.errorBackground'
        );
    }

    /**
     * 显示无API Key状态
     */
    showNoApiKey(): void {
        this.statusBarItem.text = '$(cloud) GLM: 未配置';
        this.statusBarItem.tooltip = '请在设置中配置 zhipu.apiKey';
        this.statusBarItem.backgroundColor = undefined;
    }

    /**
     * 显示加载中状态
     */
    showLoading(): void {
        this.statusBarItem.text = '$(loading~spin) GLM: 刷新中...';
    }

    dispose(): void {
        this.statusBarItem.dispose();
    }
}
