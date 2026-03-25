/**
 * 统一Webview面板
 *
 * 合并了API Key管理和用量数据展示：
 * - 顶部：多API Key输入管理（添加/删除/切换）
 * - 点击"查询"按钮后，下方显示该Key的完整额度信息（圆形进度环+数据卡片）
 */

import * as vscode from 'vscode';
import { fetchUsageData } from '../api/client';
import type { UsageData } from '../api/types';

/** 存储在配置中的API Key项 */
export interface ApiKeyItem {
    name: string;
    key: string;
}

export class WebviewManager {
    private panel: vscode.WebviewPanel | undefined;

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
            { enableScripts: true, retainContextWhenHidden: true }
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

    /**
     * 外部刷新时更新面板（重新渲染Key列表）
     */
    updateIfVisible(_data?: UsageData): void {
        // 统一面板由用户点击查询驱动，外部刷新仅更新列表
        if (this.panel) {
            this.panel.webview.html = this.getHtml();
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
        this.refreshPanel();
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
        this.refreshPanel();
    }

    private async handleQueryKey(apiKey: string, name: string): Promise<void> {
        this.post({ command: 'queryStart', name });
        try {
            const data = await fetchUsageData(apiKey);
            this.post({ command: 'queryResult', name, data });
        } catch (err) {
            const msg = err instanceof Error ? err.message : '查询失败';
            this.post({ command: 'queryError', name, text: msg });
        }
    }

    private async handleSetActive(name: string): Promise<void> {
        const config = vscode.workspace.getConfiguration('zhipu');
        await config.update('activeKeyName', name, vscode.ConfigurationTarget.Global);
        this.refreshPanel();
        vscode.commands.executeCommand('zhipu.refreshUsage');
    }

    private post(msg: Record<string, unknown>): void {
        this.panel?.webview.postMessage(msg);
    }

    private refreshPanel(): void {
        if (this.panel) {
            this.panel.webview.html = this.getHtml();
        }
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

    // ========== HTML生成 ==========

    private getKeysHtml(): string {
        const keys = this.getKeys();
        const activeName = this.getActiveName();

        if (keys.length === 0) {
            return '<div class="empty-state">暂无 API Key，请在上方添加 ✨</div>';
        }

        return keys.map(k => {
            const isActive = k.name === activeName;
            const safeName = k.name.replace(/'/g, "\\'").replace(/"/g, '&quot;');
            const safeKey = k.key.replace(/'/g, "\\'").replace(/"/g, '&quot;');
            return `
            <div class="key-row ${isActive ? 'active' : ''}" id="row-${safeName}">
                <div class="key-left">
                    <span class="key-name">${k.name}</span>
                    ${isActive ? '<span class="badge">当前</span>' : ''}
                    <span class="key-mask">${this.maskKey(k.key)}</span>
                </div>
                <div class="key-btns">
                    ${!isActive ? `<button class="btn btn-sm" onclick="setActive('${safeName}')">设为当前</button>` : ''}
                    <button class="btn btn-query" onclick="queryKey('${safeName}','${safeKey}')">🔍 查询</button>
                    <button class="btn btn-del" onclick="removeKey('${safeName}')">✕</button>
                </div>
            </div>
            <div class="result-area" id="result-${safeName}"></div>`;
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
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

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
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
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
        .btn-primary { background: var(--primary); color: #fff; box-shadow: 0 4px 15px rgba(var(--vscode-focusBorder), 0.25); }
        .btn-primary:hover { filter: brightness(1.1); transform: translateY(-2px); box-shadow: 0 6px 20px rgba(var(--vscode-focusBorder), 0.35); }

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
        .key-mask { opacity: 0.4; font-size: 12px; font-family: 'JetBrains Mono', monospace; }

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
                <button class="btn btn-primary" onclick="addKey()">✚ 绑定</button>
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
        function addKey() {
            const n = document.getElementById('iName').value.trim();
            const k = document.getElementById('iKey').value.trim();
            if (!n || !k) { toast('请填写名称和Key','error'); return; }
            vscode.postMessage({ command:'addKey', name:n, key:k });
            document.getElementById('iName').value = '';
            document.getElementById('iKey').value = '';
        }
        function removeKey(n) { vscode.postMessage({ command:'removeKey', name:n }); }
        function queryKey(n,k) { vscode.postMessage({ command:'queryKey', name:n, key:k }); }
        function setActive(n) { vscode.postMessage({ command:'setActive', name:n }); }
        function fmt(n){ return (n===undefined||n===null)?'-':Number(n).toLocaleString('en-US'); }
        function getColorInfo(p){ 
            if(p >= 85) return { hex: '#f85149', rgb: '248,81,73' };
            if(p >= 60) return { hex: '#dbab09', rgb: '219,171,9' };
            return { hex: '#2ea043', rgb: '46,160,67' };
        }
        function resetTxt(ts){
            if(!ts) return '未知';
            var d=ts-Date.now();
            if(d<=0) return '即将重置...';
            return Math.floor(d/3600000)+'小时 '+Math.floor((d%3600000)/60000)+'分';
        }
        function toast(text,type){
            var old=document.querySelector('.toast'); if(old) old.remove();
            var el=document.createElement('div');
            el.className='toast '+type; 
            el.innerHTML = (type === 'success' ? '✅ ' : '❌ ') + text;
            document.body.appendChild(el);
            setTimeout(() => el.remove(), 3000);
        }
        function buildDashboard(d) {
            var p = Math.round(d.tokenPercentage||0);
            var colorObj = getColorInfo(p);
            var offset = CIRC * (1 - p/100);
            var plan = d.planLevel ? d.planLevel.toUpperCase() : 'STANDARD';
            var html = '<div class="dashboard" style="--ring-color: '+colorObj.hex+'">';
            html += '<div class="dash-top"><h3>📊 资源看板 <span class="plan-pill">'+plan+'</span></h3><div class="dash-update">最新同步: '+d.queryTime+'</div></div>';
            html += '<div class="hero-stats"><div class="ring-wrapper">';
            html += '<svg class="ring-svg" width="160" height="160"><circle class="ring-circle ring-bg" cx="80" cy="80" r="68"/><circle class="ring-circle ring-fg" cx="80" cy="80" r="68" stroke="'+colorObj.hex+'" stroke-dasharray="'+CIRC+'" stroke-dashoffset="'+CIRC+'"/></svg>';
            html += '<div class="ring-content"><div class="ring-val" style="color:'+colorObj.hex+'">'+p+'%</div><div class="ring-label">5h 配额</div></div></div>';
            html += '<div style="flex:1; display:flex; flex-direction:column; gap:20px; padding-left:24px; border-left:1px solid rgba(255,255,255,0.05);">';
            html += '<div><div class="cd-label">已用 Token</div><div class="cd-val">'+fmt(d.tokenUsed)+'</div><div class="cd-sub">配额上限 '+fmt(d.tokenTotal)+'</div></div>';
            html += '<div><div class="cd-label">⏳ 下次重置倒计时</div><div class="cd-val">'+resetTxt(d.nextResetTime)+'</div></div>';
            html += '</div></div>';
            html += '<div class="metrics-grid">';
            if(d.weeklyPercentage!==undefined){
                var wp=Math.round(d.weeklyPercentage); var cW=getColorInfo(wp);
                html+='<div class="card-cell full"><div class="cd-label">📅 周限额周期</div><div class="cd-val">'+wp+'%</div><div class="cd-sub">周重置倒计时: '+resetTxt(d.weeklyNextResetTime)+'</div><div class="progress-track"><div class="progress-bar" data-width="'+wp+'%" style="width:0; background:'+cW.hex+'"></div></div></div>';
            }
            if(d.mcpPercentage!==undefined){
                var mp=Math.round(d.mcpPercentage); var cM=getColorInfo(mp);
                html+='<div class="card-cell full"><div class="cd-label">📦 MCP 月度资源池</div><div class="cd-val">'+mp+'%</div><div class="cd-sub">已用 '+fmt(d.mcpCurrentValue)+' / 总量 '+fmt(d.mcpTotal)+'</div><div class="progress-track"><div class="progress-bar" data-width="'+mp+'%" style="width:0; background:'+cM.hex+'"></div></div></div>';
            }
            html+='<div class="card-cell"><div class="cd-label">🤖 模型调用 (24h)</div><div class="cd-val">'+fmt(d.modelCallCount)+'</div><div class="cd-sub">消耗 Token: '+fmt(d.modelTokensUsage)+'</div></div>';
            html+='<div class="card-cell"><div class="cd-label">🔍 工具调用 (24h)</div><div class="cd-val">'+fmt(d.networkSearchCount+d.webReadCount)+'</div><div class="cd-sub">搜索 '+fmt(d.networkSearchCount)+' | 抓取 '+fmt(d.webReadCount)+'</div></div>';
            html += '</div></div>';
            setTimeout(() => {
                const fg = document.querySelector('#result-'+d._keyName+' .ring-fg');
                if(fg) fg.style.strokeDashoffset = offset;
                const pbars = document.querySelectorAll('#result-'+d._keyName+' .progress-bar');
                pbars.forEach(b => { if(b.dataset.width) b.style.width = b.dataset.width; });
            }, 50);
            return html;
        }
        window.addEventListener('message', function(e){
            const msg = e.data;
            if(msg.command==='queryStart'){
                const el = document.getElementById('result-'+msg.name);
                if(el) {
                    el.style.maxHeight = '500px';
                    el.innerHTML='<div class="result-loading"><div class="spinner"></div>正在分析 "'+msg.name+'" 的调用指纹...</div>';
                }
            }
            if(msg.command==='queryResult'){
                const el = document.getElementById('result-'+msg.name);
                if(el) {
                    msg.data._keyName = msg.name;
                    el.innerHTML = buildDashboard(msg.data);
                    el.style.maxHeight = '1500px';
                }
            }
            if(msg.command==='queryError'){
                const el = document.getElementById('result-'+msg.name);
                if(el) {
                    el.innerHTML='<div class="result-error">⚠️ '+msg.text+'</div>';
                    el.style.maxHeight = '200px';
                }
            }
            if(msg.command==='toast') toast(msg.text, msg.type);
        });

        document.getElementById('iKey').addEventListener('keydown',function(e){
            if(e.key==='Enter') addKey();
        });
        
        document.querySelectorAll('.key-row').forEach((row, idx) => {
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
