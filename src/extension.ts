/**
 * 智谱用量监控 VSCode 插件入口
 *
 * 功能:
 * 1. 状态栏实时显示5小时Token配额使用率
 * 2. 点击状态栏打开统一面板（Key管理 + 用量看板）
 * 3. 多API Key管理，支持切换和独立查询
 * 4. 支持手动刷新和自动定时刷新
 * 5. 用量过高时状态栏变色告警
 */

import * as vscode from 'vscode';
import { fetchUsageData } from './api/client';
import { StatusBarManager } from './ui/statusBar';
import { WebviewManager } from './ui/webview';
import type { UsageData, ApiKeyItem } from './api/types';

let statusBar: StatusBarManager;
let webview: WebviewManager;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let lastUsageData: UsageData | undefined;

/**
 * 获取当前激活的API Key
 */
function getActiveApiKey(): { name: string; key: string } | undefined {
    const config = vscode.workspace.getConfiguration('zhipu');
    const keys = config.get<ApiKeyItem[]>('apiKeys') || [];
    const activeName = config.get<string>('activeKeyName', '');

    if (keys.length === 0) { return undefined; }
    if (!activeName) { return keys[0]; }
    return keys.find(k => k.name === activeName) || keys[0];
}

/**
 * 获取刷新间隔（分钟）
 */
function getRefreshInterval(): number {
    return vscode.workspace.getConfiguration('zhipu').get<number>('refreshInterval', 5);
}

/**
 * 刷新用量数据（状态栏用）
 */
async function refreshUsage(): Promise<void> {
    const active = getActiveApiKey();
    if (!active) {
        statusBar.showNoApiKey();
        return;
    }

    statusBar.showLoading();

    try {
        lastUsageData = await fetchUsageData(active.key);
        statusBar.update(lastUsageData, active.name);
    } catch (err) {
        const msg = err instanceof Error ? err.message : '未知错误';
        statusBar.showError(msg);
    }
}

function startAutoRefresh(): void {
    stopAutoRefresh();
    refreshTimer = setInterval(() => refreshUsage(), getRefreshInterval() * 60 * 1000);
}

function stopAutoRefresh(): void {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = undefined; }
}

/**
 * 插件激活
 */
export function activate(context: vscode.ExtensionContext): void {
    statusBar = new StatusBarManager();
    webview = new WebviewManager();

    // 刷新用量
    const refreshCmd = vscode.commands.registerCommand('zhipu.refreshUsage', () => refreshUsage());

    // 打开统一面板（点击状态栏 或 命令面板）
    const detailsCmd = vscode.commands.registerCommand('zhipu.showDetails', () => webview.show());

    // API Key管理（也指向同一面板）
    const manageCmd = vscode.commands.registerCommand('zhipu.manageKeys', () => webview.show());

    // 监听配置变化
    const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('zhipu.apiKeys') || e.affectsConfiguration('zhipu.activeKeyName')) {
            refreshUsage();
        }
        if (e.affectsConfiguration('zhipu.refreshInterval')) {
            startAutoRefresh();
        }
    });

    context.subscriptions.push(refreshCmd, detailsCmd, manageCmd, configWatcher, {
        dispose: () => { stopAutoRefresh(); statusBar.dispose(); webview.dispose(); }
    });

    refreshUsage();
    startAutoRefresh();
}

export function deactivate(): void {
    stopAutoRefresh();
}
