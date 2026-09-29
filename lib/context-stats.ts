import type { ContextUsage, SessionStatsInfo } from "./pi-types";
import type { AgentUsage } from "./types";

/** 紧凑数字，规则与 AppShell 里 renderSessionStatsButton 内部的 formatCompact 一致。 */
export function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k`;
  return String(value);
}

export interface ContextStats {
  /** 上下文占用百分比；null 表示还没有数据（例如刚压缩完还没收到下一次响应）。 */
  percent: number | null;
  /** 会话累计总 token。 */
  totalTokens: number;
  /** 最新一次请求的缓存命中率（即时）；拿不到时为 null。 */
  hitRate: number | null;
  /** 会话累计花费。 */
  cost: number;
}

export interface ContextStatsInput {
  contextUsage?: ContextUsage | null;
  sessionStats?: SessionStatsInfo | null;
  /**
   * 最新一次请求的 usage。缓存命中率用它算（即时），而不是会话累计（平均）。
   * 取自消息列表里最后一条带 usage 的 assistant / toolResult 消息。
   */
  latestUsage?: AgentUsage | null;
}

/**
 * 上下文统计的四个数字来自两个不同的口径，很容易混淆，所以只在这里算一次：
 * - percent / totalTokens / cost 来自会话（累计）
 * - hitRate 来自「最新一次请求」的 usage（即时），拿不到时才退回累计，避免显示成空
 *
 * 输入框下方那行和 ⋯ 菜单里的 token 行都用它，保证两处永远显示同一套数字。
 */
export function computeContextStats({ contextUsage, sessionStats, latestUsage }: ContextStatsInput): ContextStats {
  const tokens = sessionStats?.tokens;
  const cacheSource = latestUsage ?? tokens ?? null;
  const cacheBase = cacheSource
    ? cacheSource.cacheRead + cacheSource.cacheWrite + cacheSource.input
    : 0;
  return {
    percent: contextUsage?.percent ?? null,
    totalTokens: tokens?.total ?? 0,
    hitRate: cacheSource && cacheBase > 0 ? (cacheSource.cacheRead / cacheBase) * 100 : null,
    cost: sessionStats?.cost ?? 0,
  };
}

/** 展示顺序：% → 总 token → 缓存命中率 → 花费。值为空的项直接省略。 */
export function contextStatsParts(
  stats: ContextStats,
  t: (key: "session.cacheHitShort") => string,
): string[] {
  const fields = contextStatFields(stats, t);
  return [...fields.context, ...fields.cache, ...fields.cost];
}

/** 四项的文案与数字只在这里格式化一次。 */
function contextStatFields(stats: ContextStats, t: (key: "session.cacheHitShort") => string) {
  const nonEmpty = (parts: (string | null)[]) => parts.filter((part): part is string => part !== null);
  return {
    context: nonEmpty([
      stats.percent !== null ? `${stats.percent.toFixed(0)}%` : null,
      stats.totalTokens > 0 ? `${compactTokens(stats.totalTokens)} tok` : null,
    ]),
    cache: nonEmpty([
      stats.hitRate !== null ? `${t("session.cacheHitShort")} ${stats.hitRate.toFixed(1)}%` : null,
    ]),
    cost: nonEmpty([
      stats.cost > 0 ? (stats.cost >= 0.01 ? `$${stats.cost.toFixed(2)}` : "<$0.01") : null,
    ]),
  };
}
