/**
 * 智谱API响应类型定义
 */

/** 配额限制项 */
export interface QuotaLimitItem {
    type: string;        // 'TOKENS_LIMIT' | 'TIME_LIMIT'
    percentage: number;  // 使用百分比 0-100
    unit?: number;       // 时间单位（小时）
    number?: number;     // 数量
    currentValue?: number;
    total?: number;
    usage?: number;
    nextResetTime?: number; // Unix时间戳（毫秒）
    usageDetails?: Array<{ modelCode: string; usage: number }>;
}

/** 配额限制响应 */
export interface QuotaLimitResponse {
    data?: {
        limits?: QuotaLimitItem[];
        level?: string;   // 套餐等级: lite, pro 等
    };
}

/** 模型使用量响应 */
export interface ModelUsageResponse {
    data?: {
        totalUsage?: {
            totalModelCallCount?: number;
            totalTokensUsage?: number;
        };
        modelUsageList?: Array<{
            modelCode: string;
            callCount: number;
            tokensUsage: number;
        }>;
    };
}

/** 工具使用量响应 */
export interface ToolUsageResponse {
    data?: {
        totalUsage?: {
            totalNetworkSearchCount?: number;
            totalWebReadMcpCount?: number;
            totalZreadMcpCount?: number;
        };
    };
}

/** 处理后的用量数据 */
export interface UsageData {
    /** 5小时Token配额百分比 */
    tokenPercentage: number;
    /** Token已用量 */
    tokenUsed: number;
    /** Token总限额 */
    tokenTotal: number;
    /** 下次重置时间（Unix毫秒） */
    nextResetTime?: number;
    /** 周限额百分比（新套餐独有） */
    weeklyPercentage?: number;
    /** 周限额下次重置时间（Unix毫秒） */
    weeklyNextResetTime?: number;
    /** MCP月度配额百分比 */
    mcpPercentage?: number;
    /** MCP当前值 */
    mcpCurrentValue?: number;
    /** MCP总量 */
    mcpTotal?: number;
    /** 24h模型调用次数 */
    modelCallCount?: number;
    /** 24h Token使用量 */
    modelTokensUsage?: number;
    /** 各模型使用详情 */
    modelUsageList?: Array<{
        modelCode: string;
        callCount: number;
        tokensUsage: number;
    }>;
    /** 网络搜索次数 */
    networkSearchCount?: number;
    /** Web读取次数 */
    webReadCount?: number;
    /** 套餐等级 */
    planLevel?: string;
    /** 查询时间 */
    queryTime: string;
}

/** API Key 配置项 */
export interface ApiKeyItem {
    name: string;
    key: string;
}
