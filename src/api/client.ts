/**
 * 智谱API客户端
 * 
 * 调用智谱监控API获取用量数据
 * 端点基于 https://open.bigmodel.cn
 * 认证方式：Authorization头直接传API Key（无Bearer前缀）
 */

import * as https from 'https';
import type {
    QuotaLimitResponse,
    ModelUsageResponse,
    ToolUsageResponse,
    UsageData
} from './types';

const BASE_URL = 'https://open.bigmodel.cn';
const ENDPOINTS = {
    quotaLimit: '/api/monitor/usage/quota/limit',
    modelUsage: '/api/monitor/usage/model-usage',
    toolUsage: '/api/monitor/usage/tool-usage'
};
const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_TOKEN_LIMIT = 40_000_000;

/**
 * 发送GET请求
 */
function httpGet<T>(path: string, apiKey: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const url = new URL(BASE_URL + path);

        const options: https.RequestOptions = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname + url.search,
            method: 'GET',
            headers: {
                'Authorization': apiKey,  // 无 Bearer 前缀
                'Accept-Language': 'zh-CN,zh',
                'Content-Type': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`API请求失败 (${res.statusCode}): ${data.substring(0, 200)}`));
                    return;
                }
                try {
                    resolve(JSON.parse(data) as T);
                } catch {
                    reject(new Error(`JSON解析失败: ${data.substring(0, 200)}`));
                }
            });
        });

        req.setTimeout(REQUEST_TIMEOUT_MS);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('请求超时'));
        });
        req.on('error', (err) => reject(new Error(`网络错误: ${err.message}`)));
        req.end();
    });
}

/**
 * 获取24小时时间窗口查询参数
 */
function getTimeWindowParams(): string {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);

    // 格式: yyyy-MM-dd HH:00:00
    const fmt = (d: Date) => {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const h = String(d.getHours()).padStart(2, '0');
        return `${y}-${m}-${day} ${h}:00:00`;
    };

    const endDate = new Date(now);
    endDate.setMinutes(59, 59, 0);

    return `startTime=${encodeURIComponent(fmt(yesterday))}&endTime=${encodeURIComponent(fmt(endDate))}`;
}

/**
 * 查询所有用量数据
 */
export async function fetchUsageData(apiKey: string): Promise<UsageData> {
    const timeParams = getTimeWindowParams();

    // 并行查询三个端点
    const [quotaRes, modelRes, toolRes] = await Promise.all([
        httpGet<QuotaLimitResponse>(ENDPOINTS.quotaLimit, apiKey).catch(() => null),
        httpGet<ModelUsageResponse>(
            `${ENDPOINTS.modelUsage}?${timeParams}`, apiKey
        ).catch(() => null),
        httpGet<ToolUsageResponse>(
            `${ENDPOINTS.toolUsage}?${timeParams}`, apiKey
        ).catch(() => null)
    ]);

    // 解析配额数据
    let tokenPercentage = 0;
    let tokenTotal = DEFAULT_TOKEN_LIMIT;
    let tokenUsed = 0;
    let nextResetTime: number | undefined;
    let mcpPercentage: number | undefined;
    let mcpCurrentValue: number | undefined;
    let mcpTotal: number | undefined;
    let planLevel: string | undefined;

    if (quotaRes?.data) {
        planLevel = quotaRes.data.level;
        const limits = quotaRes.data.limits || [];

        for (const limit of limits) {
            if (limit.type === 'TOKENS_LIMIT') {
                tokenPercentage = limit.percentage || 0;
                tokenTotal = limit.total || limit.usage || DEFAULT_TOKEN_LIMIT;
                tokenUsed = Math.round(tokenTotal * tokenPercentage / 100);
                nextResetTime = limit.nextResetTime;
            } else if (limit.type === 'TIME_LIMIT') {
                mcpPercentage = limit.percentage || 0;
                mcpCurrentValue = limit.currentValue;
                mcpTotal = limit.usage;
            }
        }
    }

    // 如果所有请求都失败了，抛出错误
    if (!quotaRes && !modelRes && !toolRes) {
        throw new Error('无法连接到智谱API，请检查网络和API Key');
    }

    return {
        tokenPercentage,
        tokenUsed,
        tokenTotal,
        nextResetTime,
        mcpPercentage,
        mcpCurrentValue,
        mcpTotal,
        modelCallCount: modelRes?.data?.totalUsage?.totalModelCallCount,
        modelTokensUsage: modelRes?.data?.totalUsage?.totalTokensUsage,
        modelUsageList: modelRes?.data?.modelUsageList,
        networkSearchCount: toolRes?.data?.totalUsage?.totalNetworkSearchCount,
        webReadCount: toolRes?.data?.totalUsage?.totalWebReadMcpCount,
        planLevel,
        queryTime: new Date().toLocaleString('zh-CN')
    };
}
