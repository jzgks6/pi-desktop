"use client";

import { useI18n } from "@/hooks/useI18n";
import { computeContextStats, contextStatsParts } from "@/lib/context-stats";
import type { ContextUsage, SessionStatsInfo } from "@/lib/pi-types";
import type { AgentUsage } from "@/lib/types";
import { ContextUsageRing } from "./ContextUsageRing";

interface ChatContextStatsProps {
  contextUsage?: ContextUsage | null;
  sessionStats?: SessionStatsInfo | null;
  /**
   * 最新一次请求的 usage。缓存命中率用它算（即时），而不是会话累计（平均）。
   * 取自消息列表里最后一条带 usage 的 assistant / toolResult 消息。
   */
  latestUsage?: AgentUsage | null;
  /** 打开信息面板（AppShell 的 activeTopPanel === "session"）。 */
  onOpenStats?: () => void;
}

/**
 * 上下文统计 —— 输入框下方控制条中间槽位里的**一个**控件。
 *
 * 圆环 + 百分比 + 总 token + 缓存命中率 + 花费，共用一个外框：
 * 外层是唯一一个 <button>，圆环以 decorative 模式画在内部（避免 button 嵌 button）。
 *
 * 四个数字与文案由 lib/context-stats.ts 统一算出，⋯ 菜单里的 token 行用的是同一套，
 * 保证两处不会歧义。
 *
 * 外框尺寸与同一行里其他控件一致（height 32 / padding 0 12px / radius 9 / font 12），
 * 见 app/native-theme.css 的 .chat-context-stats。
 * 点击打开只在中间弹出的信息面板。
 */
export function ChatContextStats({ contextUsage, sessionStats, latestUsage, onOpenStats }: ChatContextStatsProps) {
  const { t } = useI18n();

  const parts = contextStatsParts(
    computeContextStats({ contextUsage, sessionStats, latestUsage }),
    t,
  );

  if (!contextUsage && parts.length === 0) return null;

  return (
    <button
      type="button"
      className="chat-context-stats"
      onClick={() => onOpenStats?.()}
      aria-haspopup="dialog"
      title={parts.join(" · ")}
    >
      <ContextUsageRing
        contextUsage={contextUsage}
        sessionStats={sessionStats}
        decorative
      />
      {parts.map((part, index) => (
        <span key={index}>{part}</span>
      ))}
    </button>
  );
}
