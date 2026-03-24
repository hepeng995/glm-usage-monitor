/**
 * 智谱用量监控 VSCode 插件入口
 *
 * 功能:
 * 1. 状态栏实时显示5小时Token配额使用率
 * 2. 点击状态栏弹出详细Webview面板
 * 3. 支持手动刷新和自动定时刷新
 * 4. 用量过高时状态栏变色告警
 */

import * as vscode from 'vscode';
import { fetchUsageData } from './api/client';
import { StatusBarManager } from './ui/statusBar';
import { WebviewManager } from './ui/webview';
import type { UsageData } from './api/types';

let statusBar: StatusBarManager;
let webview: WebviewManager;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let lastUsageData: UsageData | undefined;

/**
 * 获取配置的API Key
 */
function getApiKey(): string {
    const config = vscode.workspace.getConfiguration('zhipu');
    return config.get<string>('apiKey', '');
}

/**
 * 获取刷新间隔（分钟）
 */
function getRefreshInterval(): number {
    const config = vscode.workspace.getConfiguration('zhipu');
    return config.get<number>('refreshInterval', 5);
}

/**
 * 刷新用量数据
 */
async function refreshUsage(): Promise<void> {
    const apiKey = getApiKey();

    if (!apiKey) {
        statusBar.showNoApiKey();
        return;
    }

    statusBar.showLoading();

    try {
        lastUsageData = await fetchUsageData(apiKey);
        statusBar.update(lastUsageData);
        webview.updateIfVisible(lastUsageData);
    } catch (err) {
        const msg = err instanceof Error ? err.message : '未知错误';
        statusBar.showError(msg);
        vscode.window.showErrorMessage(`智谱用量查询失败: ${msg}`);
    }
}

/**
 * 启动/重启自动刷新定时器
 */
function startAutoRefresh(): void {
    stopAutoRefresh();
    const intervalMinutes = getRefreshInterval();
    refreshTimer = setInterval(() => {
        refreshUsage();
    }, intervalMinutes * 60 * 1000);
}

/**
 * 停止自动刷新
 */
function stopAutoRefresh(): void {
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = undefined;
    }
}

/**
 * 插件激活
 */
export function activate(context: vscode.ExtensionContext): void {
    statusBar = new StatusBarManager();
    webview = new WebviewManager();

    // 注册刷新命令
    const refreshCmd = vscode.commands.registerCommand('zhipu.refreshUsage', () => {
        refreshUsage();
    });

    // 注册查看详情命令
    const detailsCmd = vscode.commands.registerCommand('zhipu.showDetails', () => {
        if (lastUsageData) {
            webview.show(lastUsageData, context.extensionUri);
        } else {
            // 没有数据时先刷新再显示
            refreshUsage().then(() => {
                if (lastUsageData) {
                    webview.show(lastUsageData, context.extensionUri);
                }
            });
        }
    });

    // 监听配置变化
    const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('zhipu.apiKey')) {
            refreshUsage();
        }
        if (e.affectsConfiguration('zhipu.refreshInterval')) {
            startAutoRefresh();
        }
    });

    context.subscriptions.push(refreshCmd, detailsCmd, configWatcher, {
        dispose: () => {
            stopAutoRefresh();
            statusBar.dispose();
            webview.dispose();
        }
    });

    // 初始加载
    refreshUsage();
    startAutoRefresh();
}

/**
 * 插件停用
 */
export function deactivate(): void {
    stopAutoRefresh();
}
