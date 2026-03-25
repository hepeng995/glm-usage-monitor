/**
 * API Key 管理面板
 *
 * Webview面板，用于管理多个智谱API Key，
 * 每个Key旁有"查询"按钮，可即时查看该Key的额度使用情况。
 */

import * as vscode from 'vscode';
import { fetchUsageData } from '../api/client';
import type { UsageData } from '../api/types';

/** 存储在配置中的API Key项 */
export interface ApiKeyItem {
    name: string;
    key: string;
}

export class ApiManagerPanel {
    private panel: vscode.WebviewPanel | undefined;

    show(): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.One);
            this.panel.webview.html = this.getHtml();
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'zhipuApiManager',
            '智谱 API Key 管理',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        this.panel.webview.html = this.getHtml();

        // 处理来自Webview的消息
        this.panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case 'addKey':
                    await this.handleAddKey(msg.name, msg.key);
                    break;
                case 'removeKey':
                    await this.handleRemoveKey(msg.name);
                    break;
                case 'queryKey':
                    await this.handleQueryKey(msg.key, msg.name);
                    break;
                case 'setActive':
                    await this.handleSetActive(msg.name);
                    break;
            }
        });

        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });
    }

    /** 添加API Key */
    private async handleAddKey(name: string, key: string): Promise<void> {
        if (!name || !key) {
            this.sendMessage({ command: 'error', text: '名称和Key不能为空' });
            return;
        }

        const config = vscode.workspace.getConfiguration('zhipu');
        const keys = [...(config.get<ApiKeyItem[]>('apiKeys') || [])];

        if (keys.some(k => k.name === name)) {
            this.sendMessage({ command: 'error', text: `名称 "${name}" 已存在` });
            return;
        }

        keys.push({ name, key });
        await config.update('apiKeys', keys, vscode.ConfigurationTarget.Global);

        // 如果是第一个key，自动设为激活
        if (keys.length === 1) {
            await config.update('activeKeyName', name, vscode.ConfigurationTarget.Global);
        }

        this.refreshPanel();
        this.sendMessage({ command: 'success', text: `已添加 "${name}"` });
    }

    /** 删除API Key */
    private async handleRemoveKey(name: string): Promise<void> {
        const config = vscode.workspace.getConfiguration('zhipu');
        const keys = (config.get<ApiKeyItem[]>('apiKeys') || []).filter(k => k.name !== name);
        await config.update('apiKeys', keys, vscode.ConfigurationTarget.Global);

        // 如果删除的是激活中的key
        const activeName = config.get<string>('activeKeyName', '');
        if (activeName === name) {
            const newActive = keys.length > 0 ? keys[0].name : '';
            await config.update('activeKeyName', newActive, vscode.ConfigurationTarget.Global);
        }

        this.refreshPanel();
    }

    /** 查询单个Key的额度 */
    private async handleQueryKey(apiKey: string, name: string): Promise<void> {
        this.sendMessage({ command: 'queryStart', name });

        try {
            const data = await fetchUsageData(apiKey);
            this.sendMessage({ command: 'queryResult', name, data });
        } catch (err) {
            const msg = err instanceof Error ? err.message : '查询失败';
            this.sendMessage({ command: 'queryError', name, text: msg });
        }
    }

    /** 设置激活的Key */
    private async handleSetActive(name: string): Promise<void> {
        const config = vscode.workspace.getConfiguration('zhipu');
        await config.update('activeKeyName', name, vscode.ConfigurationTarget.Global);
        this.refreshPanel();

        // 触发状态栏刷新
        vscode.commands.executeCommand('zhipu.refreshUsage');
    }

    private sendMessage(msg: Record<string, unknown>): void {
        this.panel?.webview.postMessage(msg);
    }

    private refreshPanel(): void {
        if (this.panel) {
            this.panel.webview.html = this.getHtml();
        }
    }

    /** 读取配置中的Key列表 */
    private getKeys(): ApiKeyItem[] {
        const config = vscode.workspace.getConfiguration('zhipu');
        return config.get<ApiKeyItem[]>('apiKeys') || [];
    }

    /** 获取激活的Key名称 */
    private getActiveName(): string {
        const config = vscode.workspace.getConfiguration('zhipu');
        return config.get<string>('activeKeyName', '');
    }

    /** 遮蔽Key显示 */
    private maskKey(key: string): string {
        if (key.length <= 8) { return '****'; }
        return key.substring(0, 4) + '****' + key.substring(key.length - 4);
    }

    /** 生成Key列表HTML */
    private getKeysListHtml(): string {
        const keys = this.getKeys();
        const activeName = this.getActiveName();

        if (keys.length === 0) {
            return '<div class="empty-state">还没有添加 API Key，在上方添加一个吧 ✨</div>';
        }

        return keys.map(k => {
            const isActive = k.name === activeName;
            return `
            <div class="key-card ${isActive ? 'active' : ''}">
                <div class="key-header">
                    <div class="key-info">
                        <span class="key-name">${k.name}</span>
                        ${isActive ? '<span class="active-badge">当前使用</span>' : ''}
                    </div>
                    <span class="key-value">${this.maskKey(k.key)}</span>
                </div>
                <div class="key-actions">
                    ${!isActive ? `<button class="btn btn-primary" onclick="setActive('${k.name}')">设为当前</button>` : ''}
                    <button class="btn btn-query" onclick="queryKey('${k.name}', '${k.key}')">
                        <span class="btn-icon">🔍</span> 查询额度
                    </button>
                    <button class="btn btn-danger" onclick="removeKey('${k.name}')">删除</button>
                </div>
                <div class="query-result" id="result-${k.name}" style="display:none;"></div>
            </div>`;
        }).join('');
    }

    private getHtml(): string {
        return /*html*/`<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>智谱 API Key 管理</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            padding: 24px;
            line-height: 1.6;
            max-width: 720px;
            margin: 0 auto;
        }

        .page-header {
            text-align: center;
            margin-bottom: 28px;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--vscode-widget-border, #333);
        }
        .page-header h1 { font-size: 22px; font-weight: 600; }
        .page-header p { font-size: 13px; opacity: 0.6; margin-top: 4px; }

        /* 添加表单 */
        .add-form {
            background: var(--vscode-input-background, #1e1e1e);
            border: 1px solid var(--vscode-widget-border, #333);
            border-radius: 10px;
            padding: 18px;
            margin-bottom: 24px;
        }
        .add-form h2 {
            font-size: 14px;
            margin-bottom: 12px;
            opacity: 0.8;
        }
        .form-row {
            display: flex;
            gap: 10px;
            margin-bottom: 10px;
        }
        .form-row:last-child { margin-bottom: 0; }
        input {
            flex: 1;
            padding: 8px 12px;
            border: 1px solid var(--vscode-input-border, #444);
            border-radius: 6px;
            background: var(--vscode-input-background, #2a2a2a);
            color: var(--vscode-input-foreground, #fff);
            font-size: 13px;
            outline: none;
        }
        input:focus {
            border-color: var(--vscode-focusBorder, #007acc);
        }
        input::placeholder { opacity: 0.4; }

        /* 按钮 */
        .btn {
            padding: 6px 14px;
            border: none;
            border-radius: 6px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.15s ease;
            white-space: nowrap;
        }
        .btn:hover { filter: brightness(1.15); }
        .btn:active { transform: scale(0.97); }
        .btn-add {
            background: var(--vscode-button-background, #007acc);
            color: var(--vscode-button-foreground, #fff);
            padding: 8px 20px;
            font-size: 13px;
        }
        .btn-primary {
            background: var(--vscode-button-secondaryBackground, #3a3d41);
            color: var(--vscode-button-secondaryForeground, #fff);
        }
        .btn-query {
            background: #1a6e3a;
            color: #fff;
        }
        .btn-query .btn-icon { margin-right: 2px; }
        .btn-danger {
            background: transparent;
            color: var(--vscode-errorForeground, #f44336);
            border: 1px solid var(--vscode-errorForeground, #f44336);
        }
        .btn-danger:hover { background: rgba(244,67,54,0.1); }

        /* Key卡片 */
        .key-card {
            background: var(--vscode-input-background, #1e1e1e);
            border: 1px solid var(--vscode-widget-border, #333);
            border-radius: 10px;
            padding: 16px;
            margin-bottom: 12px;
            transition: border-color 0.2s;
        }
        .key-card.active {
            border-color: var(--vscode-focusBorder, #007acc);
            border-width: 2px;
        }
        .key-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
        }
        .key-info { display: flex; align-items: center; gap: 10px; }
        .key-name {
            font-size: 15px;
            font-weight: 600;
        }
        .active-badge {
            font-size: 11px;
            padding: 2px 8px;
            border-radius: 10px;
            background: var(--vscode-focusBorder, #007acc);
            color: #fff;
            font-weight: 500;
        }
        .key-value {
            font-size: 12px;
            font-family: monospace;
            opacity: 0.5;
        }
        .key-actions {
            display: flex;
            gap: 8px;
        }

        /* 查询结果 */
        .query-result {
            margin-top: 14px;
            padding-top: 14px;
            border-top: 1px solid var(--vscode-widget-border, #2a2a2a);
        }
        .result-loading {
            text-align: center;
            padding: 12px;
            opacity: 0.6;
            font-size: 13px;
        }
        .result-error {
            color: var(--vscode-errorForeground, #f44336);
            padding: 8px 12px;
            font-size: 13px;
            border-radius: 6px;
            background: rgba(244,67,54,0.08);
        }
        .result-data {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
        }
        .result-item {
            padding: 10px;
            border-radius: 8px;
            background: var(--vscode-editor-background, #1a1a1a);
        }
        .result-item.full { grid-column: 1 / -1; }
        .result-label {
            font-size: 11px;
            text-transform: uppercase;
            opacity: 0.5;
            margin-bottom: 4px;
            letter-spacing: 0.3px;
        }
        .result-value {
            font-size: 18px;
            font-weight: 700;
        }
        .result-sub {
            font-size: 11px;
            opacity: 0.5;
            margin-top: 2px;
        }

        /* 进度条 */
        .progress-bar {
            width: 100%;
            height: 6px;
            background: var(--vscode-widget-border, #2a2a2a);
            border-radius: 3px;
            margin-top: 6px;
            overflow: hidden;
        }
        .progress-fill {
            height: 100%;
            border-radius: 3px;
            transition: width 0.4s ease;
        }

        .empty-state {
            text-align: center;
            padding: 40px;
            opacity: 0.5;
            font-size: 14px;
        }

        .toast {
            position: fixed;
            bottom: 24px;
            left: 50%;
            transform: translateX(-50%);
            padding: 10px 24px;
            border-radius: 8px;
            font-size: 13px;
            animation: fadeInUp 0.3s ease;
            z-index: 1000;
        }
        .toast.success {
            background: #1a6e3a;
            color: #fff;
        }
        .toast.error {
            background: #c62828;
            color: #fff;
        }
        @keyframes fadeInUp {
            from { opacity: 0; transform: translateX(-50%) translateY(10px); }
            to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
    </style>
</head>
<body>
    <div class="page-header">
        <h1>🔑 API Key 管理</h1>
        <p>管理多个智谱AI API Key，点击"查询额度"查看配额使用情况</p>
    </div>

    <!-- 添加表单 -->
    <div class="add-form">
        <h2>➕ 添加新的 API Key</h2>
        <div class="form-row">
            <input type="text" id="keyName" placeholder="名称（如：主账号、测试号）" />
            <input type="text" id="keyValue" placeholder="API Key（格式: id.secret）" />
            <button class="btn btn-add" onclick="addKey()">添加</button>
        </div>
    </div>

    <!-- Key列表 -->
    <div id="keyList">
        ${this.getKeysListHtml()}
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function addKey() {
            const name = document.getElementById('keyName').value.trim();
            const key = document.getElementById('keyValue').value.trim();
            if (!name || !key) {
                showToast('请填写名称和Key', 'error');
                return;
            }
            vscode.postMessage({ command: 'addKey', name, key });
            document.getElementById('keyName').value = '';
            document.getElementById('keyValue').value = '';
        }

        function removeKey(name) {
            vscode.postMessage({ command: 'removeKey', name });
        }

        function queryKey(name, key) {
            vscode.postMessage({ command: 'queryKey', name, key });
        }

        function setActive(name) {
            vscode.postMessage({ command: 'setActive', name });
        }

        function fmtNum(n) {
            if (n === undefined || n === null) return '-';
            return Number(n).toLocaleString('en-US');
        }

        function getColor(pct) {
            if (pct >= 85) return '#f44336';
            if (pct >= 60) return '#ff9800';
            return '#4caf50';
        }

        function getResetText(ts) {
            if (!ts) return '未知';
            const diff = ts - Date.now();
            if (diff <= 0) return '即将重置';
            const h = Math.floor(diff / 3600000);
            const m = Math.floor((diff % 3600000) / 60000);
            return h + 'h ' + m + 'm';
        }

        function showToast(text, type) {
            const existing = document.querySelector('.toast');
            if (existing) existing.remove();
            const el = document.createElement('div');
            el.className = 'toast ' + type;
            el.textContent = text;
            document.body.appendChild(el);
            setTimeout(() => el.remove(), 2500);
        }

        // 接收插件消息
        window.addEventListener('message', (event) => {
            const msg = event.data;

            if (msg.command === 'queryStart') {
                const el = document.getElementById('result-' + msg.name);
                if (el) {
                    el.style.display = 'block';
                    el.innerHTML = '<div class="result-loading">⏳ 正在查询...</div>';
                }
            }

            if (msg.command === 'queryResult') {
                const el = document.getElementById('result-' + msg.name);
                if (!el) return;
                const d = msg.data;
                const pct = Math.round(d.tokenPercentage || 0);
                const color = getColor(pct);
                el.style.display = 'block';
                el.innerHTML = '<div class="result-data">' +
                    '<div class="result-item full">' +
                        '<div class="result-label">5小时 Token 配额</div>' +
                        '<div class="result-value" style="color:' + color + '">' + pct + '%</div>' +
                        '<div class="result-sub">已用 ' + fmtNum(d.tokenUsed) + ' / 总量 ' + fmtNum(d.tokenTotal) + '</div>' +
                        '<div class="progress-bar"><div class="progress-fill" style="width:' + Math.min(pct,100) + '%;background:' + color + '"></div></div>' +
                        '<div class="result-sub" style="margin-top:6px">⏰ 重置: ' + getResetText(d.nextResetTime) + '</div>' +
                    '</div>' +
                    '<div class="result-item">' +
                        '<div class="result-label">24h 模型调用</div>' +
                        '<div class="result-value">' + fmtNum(d.modelCallCount) + '</div>' +
                        '<div class="result-sub">Token: ' + fmtNum(d.modelTokensUsage) + '</div>' +
                    '</div>' +
                    '<div class="result-item">' +
                        '<div class="result-label">24h 网络搜索</div>' +
                        '<div class="result-value">' + fmtNum(d.networkSearchCount) + '</div>' +
                        '<div class="result-sub">Web读取: ' + fmtNum(d.webReadCount) + '</div>' +
                    '</div>' +
                    (d.planLevel ? '<div class="result-sub" style="grid-column:1/-1;text-align:right;padding:4px">套餐: ' + d.planLevel + ' · ' + d.queryTime + '</div>' : '') +
                '</div>';
            }

            if (msg.command === 'queryError') {
                const el = document.getElementById('result-' + msg.name);
                if (el) {
                    el.style.display = 'block';
                    el.innerHTML = '<div class="result-error">❌ ' + msg.text + '</div>';
                }
            }

            if (msg.command === 'success') {
                showToast(msg.text, 'success');
            }

            if (msg.command === 'error') {
                showToast(msg.text, 'error');
            }
        });

        // Enter键提交
        document.getElementById('keyValue').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') addKey();
        });
    </script>
</body>
</html>`;
    }

    dispose(): void {
        this.panel?.dispose();
    }
}
