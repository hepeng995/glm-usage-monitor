/**
 * 统一Webview面板
 *
 * 合并了API Key管理和用量数据展示：
 * - 顶部：多API Key输入管理（添加/删除/切换）
 * - 点击"查询"按钮后，下方显示该Key的完整额度信息（圆形进度环+数据卡片）
 *
 * 安全设计：
 * - API Key 不暴露到 HTML/JS 中，查询时仅传 name 到扩展侧，由扩展侧查找 Key 发起请求
 * - 使用 data-* 属性 + 事件委托替代内联 onclick，防止 XSS
 * - 增量 DOM 更新替代全量重建，查询结果不丢失
 */

import * as vscode from 'vscode';
import { fetchUsageData } from '../api/client';
import type { UsageData, ApiKeyItem } from '../api/types';

/** 查询缓存项 */
interface CacheEntry {
    data: UsageData;
    timestamp: number;
}

const CACHE_TTL_MS = 30_000; // 30秒缓存

export class WebviewManager {
    private panel: vscode.WebviewPanel | undefined;
    private queryCache = new Map<string, CacheEntry>();

    /**
     * 显示面板（无需传入data，面板自行管理查询）
     */
    show(): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.One);
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'zhipuUsage',
            '智谱用量监控',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        this.panel.webview.html = this.getHtml();

        // 处理Webview消息
        this.panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case 'addKey':
                    await this.handleAddKey(msg.name, msg.key);
                    break;
                case 'removeKey':
                    await this.handleRemoveKey(msg.name);
                    break;
                case 'queryKey':
                    // 安全：Webview 只传 name，由扩展侧的 handleQueryKey 查找 Key
                    await this.handleQueryKey(msg.name);
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

    /**
     * 外部刷新时更新面板（通过消息增量更新Key列表）
     */
    updateIfVisible(_data?: UsageData): void {
        if (this.panel) {
            this.sendKeyList();
        }
    }

    isVisible(): boolean {
        return this.panel?.visible ?? false;
    }

    // ========== 消息处理 ==========

    private async handleAddKey(name: string, key: string): Promise<void> {
        if (!name || !key) {
            this.post({ command: 'toast', type: 'error', text: '名称和Key不能为空' });
            return;
        }
        const config = vscode.workspace.getConfiguration('zhipu');
        const keys = [...(config.get<ApiKeyItem[]>('apiKeys') || [])];
        if (keys.some(k => k.name === name)) {
            this.post({ command: 'toast', type: 'error', text: `"${name}" 已存在` });
            return;
        }
        keys.push({ name, key });
        await config.update('apiKeys', keys, vscode.ConfigurationTarget.Global);
        if (keys.length === 1) {
            await config.update('activeKeyName', name, vscode.ConfigurationTarget.Global);
        }
        this.sendKeyList();
        this.post({ command: 'toast', type: 'success', text: `已添加 "${name}"` });
    }

    private async handleRemoveKey(name: string): Promise<void> {
        const config = vscode.workspace.getConfiguration('zhipu');
        const keys = (config.get<ApiKeyItem[]>('apiKeys') || []).filter(k => k.name !== name);
        await config.update('apiKeys', keys, vscode.ConfigurationTarget.Global);
        const activeName = config.get<string>('activeKeyName', '');
        if (activeName === name) {
            await config.update('activeKeyName', keys[0]?.name || '', vscode.ConfigurationTarget.Global);
        }
        this.queryCache.delete(name);
        this.sendKeyList();
    }

    /**
     * 安全版查询：仅接收 name，由扩展侧查找 Key
     */
    private async handleQueryKey(name: string): Promise<void> {
        // 检查缓存
        const cached = this.queryCache.get(name);
        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
            this.post({ command: 'queryResult', name, data: cached.data });
            return;
        }

        // 根据 name 查找 API Key
        const keys = this.getKeys();
        const keyItem = keys.find(k => k.name === name);
        if (!keyItem) {
            this.post({ command: 'queryError', name, text: `未找到 Key "${name}"` });
            return;
        }

        this.post({ command: 'queryStart', name });
        try {
            const data = await fetchUsageData(keyItem.key);
            // 写入缓存
            this.queryCache.set(name, { data, timestamp: Date.now() });
            this.post({ command: 'queryResult', name, data });
        } catch (err) {
            const msg = err instanceof Error ? err.message : '查询失败';
            this.post({ command: 'queryError', name, text: msg });
        }
    }

    private async handleSetActive(name: string): Promise<void> {
        const config = vscode.workspace.getConfiguration('zhipu');
        await config.update('activeKeyName', name, vscode.ConfigurationTarget.Global);
        this.sendKeyList();
        vscode.commands.executeCommand('zhipu.refreshUsage');
    }

    private post(msg: Record<string, unknown>): void {
        this.panel?.webview.postMessage(msg);
    }

    /**
     * 增量更新：通过消息发送 Key 列表数据，由 Webview 侧渲染
     * 替代原来的全量 HTML 重建
     */
    private sendKeyList(): void {
        const keys = this.getKeys();
        const activeName = this.getActiveName();
        const safeKeys = keys.map(k => ({
            name: k.name,
            maskedKey: this.maskKey(k.key),
            isActive: k.name === activeName
        }));
        this.post({ command: 'updateKeyList', keys: safeKeys });
    }

    // ========== 数据读取 ==========

    private getKeys(): ApiKeyItem[] {
        return vscode.workspace.getConfiguration('zhipu').get<ApiKeyItem[]>('apiKeys') || [];
    }

    private getActiveName(): string {
        return vscode.workspace.getConfiguration('zhipu').get<string>('activeKeyName', '');
    }

    private maskKey(key: string): string {
        const parts = key.split('.');
        if (parts.length !== 2) return '********';
        return `${parts[0].slice(0, 4)}...${parts[1].slice(-4)}`;
    }

    /**
     * HTML 转义，防止 XSS
     */
    private escapeHtml(str: string): string {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ========== HTML生成 ==========

    private getKeysHtml(): string {
        const keys = this.getKeys();
        const activeName = this.getActiveName();

        if (keys.length === 0) {
            return '<div class="empty-state">暂无 API Key，请在上方添加 ✨</div>';
        }

        return keys.map(k => {
            const isActive = k.name === activeName;
            const escapedName = this.escapeHtml(k.name);
            return `
            <div class="key-row ${isActive ? 'active' : ''}" data-name="${escapedName}">
                <div class="key-left">
                    <span class="key-name">${escapedName}</span>
                    ${isActive ? '<span class="badge">当前</span>' : ''}
                    <span class="key-mask">${this.maskKey(k.key)}</span>
                </div>
                <div class="key-btns">
                    ${!isActive ? `<button class="btn btn-sm" data-action="setActive">设为当前</button>` : ''}
                    <button class="btn btn-query" data-action="queryKey">🔍 查询</button>
                    <button class="btn btn-del" data-action="removeKey">✕</button>
                </div>
            </div>
            <div class="result-area" id="result-${escapedName}"></div>`;
        }).join('');
    }

    private getHtml(): string {
        const circumference = 2 * Math.PI * 68;

        return /*html*/`<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>智谱用量监控</title>
    <style>
        :root {
            --primary: var(--vscode-focusBorder, #007acc);
            --bg: var(--vscode-editor-background);
            --fg: var(--vscode-foreground);
            --glass-bg: rgba(255, 255, 255, 0.03);
            --glass-border: rgba(255, 255, 255, 0.1);
            --glass-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
            --success: #2ea043;
            --warning: #dbab09;
            --danger: #f85149;
            --card-radius: 16px;
        }

        /* 基础设置 */
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: var(--vscode-font-family, 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif);
            color: var(--fg);
            background: var(--bg);
            overflow-x: hidden;
            padding: 40px 24px;
            line-height: 1.5;
            -webkit-font-smoothing: antialiased;
        }

        /* 背景渲染：动态 Mesh Gradient 弥散效果 */
        .mesh-bg {
            position: fixed;
            top: 0; left: 0; width: 100vw; height: 100vh;
            z-index: -1;
            background: var(--bg);
            background-image: 
                radial-gradient(at 10% 20%, rgba(var(--vscode-focusBorder), 0.08) 0px, transparent 50%),
                radial-gradient(at 90% 10%, rgba(46, 160, 67, 0.05) 0px, transparent 40%),
                radial-gradient(at 50% 90%, rgba(219, 171, 9, 0.04) 0px, transparent 50%);
            filter: blur(80px);
        }

        .container {
            max-width: 800px;
            margin: 0 auto;
        }

        /* 顶部标题区 */
        .header {
            text-align: center;
            margin-bottom: 48px;
            animation: fadeInDown 0.8s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .header h1 {
            font-size: 32px;
            font-weight: 800;
            letter-spacing: -1px;
            margin-bottom: 12px;
            background: linear-gradient(135deg, var(--fg) 30%, #a0a0a0 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .header p {
            font-size: 15px;
            opacity: 0.5;
            font-weight: 400;
        }

        /* 毛玻璃控制卡片 */
        .glass-card {
            background: var(--glass-bg);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid var(--glass-border);
            border-radius: var(--card-radius);
            box-shadow: var(--glass-shadow);
            padding: 24px;
            margin-bottom: 32px;
            transition: transform 0.3s ease, box-shadow 0.3s ease;
        }
        .glass-card:hover { border-color: rgba(255, 255, 255, 0.15); }

        .input-group {
            display: grid;
            grid-template-columns: 1fr 2fr auto;
            gap: 12px;
            align-items: center;
        }

        input {
            width: 100%;
            padding: 12px 16px;
            background: rgba(0, 0, 0, 0.2);
            border: 1px solid rgba(255, 255, 255, 0.05);
            border-radius: 10px;
            color: #fff;
            font-size: 14px;
            transition: all 0.2s;
            font-family: inherit;
        }
        input:focus {
            outline: none;
            border-color: var(--primary);
            background: rgba(0, 0, 0, 0.35);
            box-shadow: 0 0 0 3px rgba(var(--vscode-focusBorder), 0.1);
        }

        /* 按钮美化 */
        .btn {
            padding: 10px 20px;
            border-radius: 10px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
            border: none;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        }
        .btn:active { transform: scale(0.96); }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .btn-primary { background: var(--primary); color: #fff; box-shadow: 0 4px 15px rgba(var(--vscode-focusBorder), 0.25); }
        .btn-primary:hover:not(:disabled) { filter: brightness(1.1); transform: translateY(-2px); box-shadow: 0 6px 20px rgba(var(--vscode-focusBorder), 0.35); }

        /* Key 列表行 */
        .key-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 18px 24px;
            background: var(--glass-bg);
            backdrop-filter: blur(12px);
            border: 1px solid var(--glass-border);
            border-radius: var(--card-radius);
            margin-bottom: 16px;
            animation: slideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) backwards;
        }
        .key-row.active { border-color: var(--primary); background: rgba(var(--vscode-focusBorder), 0.03); box-shadow: 0 0 0 1px var(--primary); }
        .key-left { display: flex; align-items: center; gap: 14px; }
        .key-name { font-weight: 600; font-size: 16px; }
        .badge { background: var(--primary); color: #fff; font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 20px; text-transform: uppercase; }
        .key-mask { opacity: 0.4; font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); }

        /* 看板设计 */
        .dashboard {
            margin-top: 24px;
            padding: 28px;
            background: rgba(0, 0, 0, 0.2);
            border-radius: 20px;
            border: 1px solid var(--glass-border);
            animation: expandIn 0.5s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .dash-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; }
        .dash-title h3 { font-size: 18px; font-weight: 700; display: flex; align-items: center; gap: 10px; }
        .dash-update { font-size: 12px; opacity: 0.4; margin-top: 4px; }
        .plan-pill { background: rgba(255, 255, 255, 0.05); padding: 4px 12px; border-radius: 12px; font-size: 11px; font-weight: 600; border: 1px solid var(--glass-border); }

        /* 核心环形进度 */
        .hero-stats { display: flex; align-items: center; justify-content: center; gap: 60px; margin-bottom: 40px; }
        .ring-wrapper { position: relative; width: 160px; height: 160px; }
        .ring-svg { transform: rotate(-90deg); }
        .ring-circle { fill: none; stroke-width: 10; stroke-linecap: round; }
        .ring-bg { stroke: rgba(255, 255, 255, 0.04); }
        .ring-fg { transition: stroke-dashoffset 1.5s cubic-bezier(0.16, 1, 0.3, 1); filter: drop-shadow(0 0 6px var(--ring-color)); }
        .ring-content { position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: flex; flex-direction: column; justify-content: center; align-items: center; }
        .ring-val { font-size: 38px; font-weight: 800; letter-spacing: -1px; }
        .ring-label { font-size: 12px; opacity: 0.5; }

        /* 统计卡片网格 */
        .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-top: 24px; }
        .card-cell { padding: 20px; background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.03); border-radius: 16px; transition: all 0.3s; }
        .card-cell:hover { background: rgba(255, 255, 255, 0.04); transform: translateY(-3px); }
        .card-cell.full { grid-column: 1 / -1; }
        .cd-label { font-size: 11px; font-weight: 700; opacity: 0.4; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; display: flex; align-items: center; gap: 6px; }
        .cd-val { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
        .cd-sub { font-size: 12px; opacity: 0.4; }
        .timer-pill {
            margin-top: 14px;
            padding: 10px 16px;
            background: rgba(var(--vscode-focusBorder), 0.1);
            border: 1px solid rgba(var(--vscode-focusBorder), 0.2);
            border-radius: 12px;
            display: inline-block;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
        }
        .timer-value {
            font-size: 22px;
            font-weight: 800;
            color: var(--primary);
            letter-spacing: -0.5px;
        }
        .progress-track { width: 100%; height: 5px; background: rgba(255,255,255,0.05); border-radius: 10px; margin-top: 14px; overflow: hidden; }
        .progress-bar { height: 100%; border-radius: 10px; transition: width 1.2s cubic-bezier(0.16, 1, 0.3, 1); }

        /* Toast */
        .toast { position: fixed; bottom: 32px; left: 50%; transform: translateX(-50%); padding: 12px 24px; border-radius: 12px; font-size: 14px; font-weight: 500; z-index: 9999; backdrop-filter: blur(10px); color: #fff; border: 1px solid rgba(255, 255, 255, 0.1); animation: toastIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards; display: flex; align-items: center; gap: 8px; }
        .toast.success { background: rgba(46, 160, 67, 0.85); box-shadow: 0 8px 20px rgba(46, 160, 67, 0.2); }
        .toast.error { background: rgba(248, 81, 73, 0.85); box-shadow: 0 8px 20px rgba(248, 81, 73, 0.2); }

        .empty-state { text-align: center; padding: 40px; opacity: 0.5; font-size: 14px; }

        @keyframes fadeInDown { from { opacity: 0; transform: translateY(-20px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(15px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes expandIn { from { opacity: 0; transform: scale(0.98); } to { opacity: 1; transform: scale(1); } }
        @keyframes spin { 100% { transform: rotate(360deg); } }
        @keyframes toastIn { from { opacity: 0; transform: translate(-50%, 20px); } to { opacity: 1; transform: translate(-50%, 0); } }
    </style>
</head>
<body>
    <div class="mesh-bg"></div>
    <div class="container">
        <div class="header">
            <h1>✨ 智谱用量中心</h1>
            <p>BigModel API 全局配额与调用指纹实时监控</p>
        </div>
        <div class="glass-card">
            <div class="input-group">
                <input id="iName" placeholder="标识名称 (例: 研发)" autocomplete="off" />
                <input id="iKey" placeholder="API Key (id.secret)" type="password" autocomplete="off" />
                <button class="btn btn-primary" id="btnAdd">✚ 绑定</button>
            </div>
        </div>
        <div id="keyList">
            ${this.getKeysHtml()}
        </div>
        <div style="text-align: center; opacity: 0.15; font-size: 11px; margin-top: 60px;">
            ZHIPU USAGE MONITOR · DESIGNED BY ANTIGRAVITY 🐾
        </div>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        const CIRC = ${circumference.toFixed(2)};

        // ===== 安全：事件委托代替内联 onclick =====
        document.getElementById('btnAdd').addEventListener('click', addKey);
        document.getElementById('iKey').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') addKey();
        });
        document.getElementById('iName').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') document.getElementById('iKey').focus();
        });

        // 事件委托：所有 key-row 按钮操作
        document.getElementById('keyList').addEventListener('click', function(e) {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const row = btn.closest('.key-row');
            if (!row) return;
            const name = row.dataset.name;
            const action = btn.dataset.action;
            if (action === 'queryKey') {
                // 安全：只传 name，不传 key
                btn.disabled = true;
                btn.textContent = '⏳ 查询中...';
                vscode.postMessage({ command: 'queryKey', name: name });
            } else if (action === 'setActive') {
                vscode.postMessage({ command: 'setActive', name: name });
            } else if (action === 'removeKey') {
                vscode.postMessage({ command: 'removeKey', name: name });
            }
        });

        function addKey() {
            const n = document.getElementById('iName').value.trim();
            const k = document.getElementById('iKey').value.trim();
            if (!n || !k) { toast('请填写名称和Key', 'error'); return; }
            vscode.postMessage({ command: 'addKey', name: n, key: k });
            document.getElementById('iName').value = '';
            document.getElementById('iKey').value = '';
        }

        function fmt(n) { return (n === undefined || n === null) ? '-' : Number(n).toLocaleString('en-US'); }
        function getColorInfo(p) {
            if (p >= 85) return { hex: '#f85149', rgb: '248,81,73' };
            if (p >= 60) return { hex: '#dbab09', rgb: '219,171,9' };
            return { hex: '#2ea043', rgb: '46,160,67' };
        }
        function resetTxt(ts) {
            if (!ts) return '未知';
            var d = ts - Date.now();
            if (d <= 0) return '即将重置...';
            return Math.floor(d / 3600000) + '小时 ' + Math.floor((d % 3600000) / 60000) + '分';
        }
        function toast(text, type) {
            var old = document.querySelector('.toast'); if (old) old.remove();
            var el = document.createElement('div');
            el.className = 'toast ' + type;
            el.textContent = (type === 'success' ? '✅ ' : '❌ ') + text;
            document.body.appendChild(el);
            setTimeout(function() { el.remove(); }, 3000);
        }
        function esc(s) {
            var d = document.createElement('div');
            d.textContent = s;
            return d.innerHTML;
        }

        // ===== 增量更新 Key 列表（不丢失查询结果） =====
        function renderKeyList(keys) {
            var container = document.getElementById('keyList');
            if (!keys || keys.length === 0) {
                container.innerHTML = '<div class="empty-state">暂无 API Key，请在上方添加 ✨</div>';
                return;
            }
            // 保存现有查询结果
            var savedResults = {};
            container.querySelectorAll('.result-area').forEach(function(el) {
                if (el.innerHTML.trim()) {
                    savedResults[el.id] = el.innerHTML;
                }
            });
            var html = '';
            keys.forEach(function(k) {
                var name = esc(k.name);
                html += '<div class="key-row ' + (k.isActive ? 'active' : '') + '" data-name="' + name + '">';
                html += '<div class="key-left"><span class="key-name">' + name + '</span>';
                if (k.isActive) html += '<span class="badge">当前</span>';
                html += '<span class="key-mask">' + esc(k.maskedKey) + '</span></div>';
                html += '<div class="key-btns">';
                if (!k.isActive) html += '<button class="btn btn-sm" data-action="setActive">设为当前</button>';
                html += '<button class="btn btn-query" data-action="queryKey">🔍 查询</button>';
                html += '<button class="btn btn-del" data-action="removeKey">✕</button>';
                html += '</div></div>';
                html += '<div class="result-area" id="result-' + name + '"></div>';
            });
            container.innerHTML = html;
            // 恢复查询结果
            Object.keys(savedResults).forEach(function(id) {
                var el = document.getElementById(id);
                if (el) el.innerHTML = savedResults[id];
            });
            // 动画延迟
            container.querySelectorAll('.key-row').forEach(function(row, idx) {
                row.style.animationDelay = (0.1 + idx * 0.08) + 's';
            });
        }

        function buildDashboard(d) {
            var p = Math.round(d.tokenPercentage || 0);
            var colorObj = getColorInfo(p);
            var offset = CIRC * (1 - p / 100);
            var plan = d.planLevel ? d.planLevel.toUpperCase() : 'STANDARD';
            var html = '<div class="dashboard" style="--ring-color: ' + colorObj.hex + '">';
            html += '<div class="dash-top"><h3>📊 资源看板 <span class="plan-pill">' + plan + '</span></h3><div class="dash-update">最新同步: ' + esc(d.queryTime) + '</div></div>';
            html += '<div class="hero-stats"><div class="ring-wrapper">';
            html += '<svg class="ring-svg" width="160" height="160"><circle class="ring-circle ring-bg" cx="80" cy="80" r="68"/><circle class="ring-circle ring-fg" cx="80" cy="80" r="68" stroke="' + colorObj.hex + '" stroke-dasharray="' + CIRC + '" stroke-dashoffset="' + CIRC + '"/></svg>';
            html += '<div class="ring-content"><div class="ring-val" style="color:' + colorObj.hex + '">' + p + '%</div><div class="ring-label">5h 配额</div></div></div>';
            html += '<div style="flex:1; display:flex; flex-direction:column; gap:20px; padding-left:24px; border-left:1px solid rgba(255,255,255,0.05);">';
            html += '<div><div class="cd-label">已用 Token</div><div class="cd-val">' + fmt(d.tokenUsed) + '</div><div class="cd-sub">配额上限 ' + fmt(d.tokenTotal) + '</div></div>';
            html += '<div><div class="cd-label">⏳ 下次重置倒计时</div><div class="cd-val">' + resetTxt(d.nextResetTime) + '</div></div>';
            html += '</div></div>';
            html += '<div class="metrics-grid">';
            if (d.weeklyPercentage !== undefined) {
                var wp = Math.round(d.weeklyPercentage); var cW = getColorInfo(wp);
                html += '<div class="card-cell full"><div class="cd-label">📅 周限额周期</div><div class="cd-val">' + wp + '%</div><div class="cd-sub">周重置倒计时: ' + resetTxt(d.weeklyNextResetTime) + '</div><div class="progress-track"><div class="progress-bar" data-width="' + wp + '%" style="width:0; background:' + cW.hex + '"></div></div></div>';
            }
            if (d.mcpPercentage !== undefined) {
                var mp = Math.round(d.mcpPercentage); var cM = getColorInfo(mp);
                html += '<div class="card-cell full"><div class="cd-label">📦 MCP 月度资源池</div><div class="cd-val">' + mp + '%</div><div class="cd-sub">已用 ' + fmt(d.mcpCurrentValue) + ' / 总量 ' + fmt(d.mcpTotal) + '</div><div class="progress-track"><div class="progress-bar" data-width="' + mp + '%" style="width:0; background:' + cM.hex + '"></div></div></div>';
            }
            html += '<div class="card-cell"><div class="cd-label">🤖 模型调用 (24h)</div><div class="cd-val">' + fmt(d.modelCallCount) + '</div><div class="cd-sub">消耗 Token: ' + fmt(d.modelTokensUsage) + '</div></div>';
            html += '<div class="card-cell"><div class="cd-label">🔍 工具调用 (24h)</div><div class="cd-val">' + fmt(d.networkSearchCount + d.webReadCount) + '</div><div class="cd-sub">搜索 ' + fmt(d.networkSearchCount) + ' | 抓取 ' + fmt(d.webReadCount) + '</div></div>';
            html += '</div></div>';
            return { html: html, offset: offset };
        }

        window.addEventListener('message', function(e) {
            var msg = e.data;
            if (msg.command === 'updateKeyList') {
                renderKeyList(msg.keys);
            }
            if (msg.command === 'queryStart') {
                var el = document.getElementById('result-' + msg.name);
                if (el) {
                    el.style.maxHeight = '500px';
                    el.innerHTML = '<div class="result-loading"><div class="spinner"></div>正在分析 "' + esc(msg.name) + '" 的调用指纹...</div>';
                }
            }
            if (msg.command === 'queryResult') {
                var el = document.getElementById('result-' + msg.name);
                if (el) {
                    var result = buildDashboard(msg.data);
                    el.innerHTML = result.html;
                    el.style.maxHeight = '1500px';
                    // 延迟触发动画
                    setTimeout(function() {
                        var fg = el.querySelector('.ring-fg');
                        if (fg) fg.style.strokeDashoffset = result.offset;
                        el.querySelectorAll('.progress-bar').forEach(function(b) {
                            if (b.dataset.width) b.style.width = b.dataset.width;
                        });
                    }, 50);
                }
                // 恢复查询按钮
                restoreQueryBtn(msg.name);
            }
            if (msg.command === 'queryError') {
                var el = document.getElementById('result-' + msg.name);
                if (el) {
                    el.innerHTML = '<div class="result-error">⚠️ ' + esc(msg.text) + '</div>';
                    el.style.maxHeight = '200px';
                }
                restoreQueryBtn(msg.name);
            }
            if (msg.command === 'toast') toast(msg.text, msg.type);
        });

        function restoreQueryBtn(name) {
            var row = document.querySelector('.key-row[data-name="' + name + '"]');
            if (row) {
                var btn = row.querySelector('[data-action="queryKey"]');
                if (btn) { btn.disabled = false; btn.textContent = '🔍 查询'; }
            }
        }

        // 初始化动画延迟
        document.querySelectorAll('.key-row').forEach(function(row, idx) {
            row.style.animationDelay = (0.2 + idx * 0.1) + 's';
        });
    </script>
</body>
</html>`;
    }


    dispose(): void {
        this.panel?.dispose();
    }
}
