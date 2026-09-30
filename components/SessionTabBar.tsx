"use client";

import { useRef } from "react";
import { useI18n } from "@/hooks/useI18n";
import { TAB_STRIP_SCROLL_STEP, useTabStripScroll } from "@/hooks/useTabStripScroll";
import { useTabStripDrag } from "@/hooks/useTabStripDrag";
import type { SessionTab } from "@/lib/session-tabs";

export interface SessionTabView {
  tab: SessionTab;
  title: string;
  /** 该会话正在跑（streaming）。标签上显示一个呼吸圆点。 */
  running: boolean;
}

interface Props {
  tabs: SessionTabView[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  /** 中栏标签条右侧的 +（与侧栏那个 + 等价）。没有可用 cwd 时不传。 */
  onNewTab?: () => void;
  /** 拖动排序：把 `tabId` 挪到 `toIndex`（移动后的下标）。不传就不可拖。 */
  onReorder?: (tabId: string, toIndex: number) => void;
}

/**
 * 中栏顶栏的会话标签条，取代了原来的扩展状态行。
 *
 * 长得像浏览器的标签栏：每个标签一个会话（或一个空白新会话），可点、可关、可加。
 * 标签多了**不换行也不压缩**，而是整条横向滚动 —— 所以两端各有一个滚动按钮，
 * 只在那一侧真的还有内容时才出现。滚轮也映射成横向滚动（桌面 app 里
 * WKWebView 的 overlay 滚动条平时是看不见的，光靠拖不行）。
 */
export function SessionTabBar({ tabs, activeTabId, onSelectTab, onCloseTab, onNewTab, onReorder }: Props) {
  const { t } = useI18n();

  // 滚动行为（两端箭头 / 滚轮映射 / 活动标签自动进视野）与右栏文件标签条共用同一份
  // 实现，见 hooks/useTabStripScroll.ts —— 几个容易跑偏的边界条件写在那里。
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { overflow, scrollBy, handleWheel, getViewport } = useTabStripScroll({
    containerRef,
    viewportSelector: ".session-tabs-list",
    activeSelector: '[data-session-tab-id][aria-selected="true"]',
    revealKey: `${activeTabId ?? ""}:${tabs.length}`,
    itemCount: tabs.length,
  });

  // 拖动回调是在 window 的 pointermove 里跑的，读到的必须是**最新**的 tabs ——
  // 闭包里那份是按下那一刻的，重排一次之后就过期了。
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // 拖动排序同样与右栏文件标签条共用（hooks/useTabStripDrag.ts）。这里走「逐项绑定」
  // 那个入口 —— 标签是我们自己渲染的；右栏碰不到上游的 JSX，那边走事件委托。
  const { handleItemPointerDown, suppressClickRef } = useTabStripDrag({
    containerRef,
    viewportSelector: ".session-tabs-list",
    itemSelector: "[data-session-tab-id]",
    onReorder: onReorder
      ? (fromIndex, toIndex) => {
          const moved = tabsRef.current[fromIndex];
          if (moved) onReorder(moved.tab.id, toIndex);
        }
      : undefined,
    // 关闭按钮上按下不算拖（那是点击）。
    ignoreTarget: (target) => !!target.closest(".session-tab-close"),
  });

  if (tabs.length === 0 && !onNewTab) return null;

  return (
    <div className="session-tabs" role="presentation" ref={containerRef}>
      {/* 到左端时直接卸载，**不留空位**（不是 visibility 隐藏）。
          注意：箭头显隐会改变列表宽度，而「该不该显箭头」又由滚动位置算出来 ——
          所以**绝不能在整条列表 resize 时去滚回活动标签**，否则到右端卸载箭头 →
          列表变宽 → 又被拽回活动标签 → 永达滑不到头（见下面 ResizeObserver 里的过滤）。 */}
      {overflow.left && (
        <button
          type="button"
          className="tab-strip-scroll"
          onClick={() => scrollBy(-TAB_STRIP_SCROLL_STEP)}
          title={t("tabStrip.scrollLeft")}
          aria-label={t("tabStrip.scrollLeft")}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 6 9 12 15 18" />
          </svg>
        </button>
      )}

      <div
        className="session-tabs-list"
        role="tablist"
        aria-label={t("sessionTab.list")}
        onWheel={handleWheel}
      >
        {tabs.map(({ tab, title, running }) => {
          const isActive = tab.id === activeTabId;
          const label = running ? `${title} · ${t("sessionTab.running")}` : title;
          return (
            <div
              key={tab.id}
              role="tab"
              data-session-tab-id={tab.id}
              aria-selected={isActive}
              aria-label={label}
              title={label}
              tabIndex={isActive ? 0 : -1}
              /* 拖动中那个标签的样式（抬起来的阴影 / cursor）由 useTabStripDrag
                 直接往节点上挂 `is-dragging` 类 —— 不走 React state，
                 拖动过程就不必每帧重渲染。 */
              className={`session-tab${isActive ? " is-active" : ""}`}
              onPointerDown={handleItemPointerDown}
              onClick={() => {
                if (suppressClickRef.current) return;
                onSelectTab(tab.id);
              }}
              onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                event.stopPropagation();
                onCloseTab(tab.id);
              }}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectTab(tab.id);
                  return;
                }
                if (event.key === "Delete" || event.key === "Backspace") {
                  event.preventDefault();
                  onCloseTab(tab.id);
                  return;
                }
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const index = tabs.findIndex((item) => item.tab.id === tab.id);
                const nextIndex = event.key === "Home" ? 0
                  : event.key === "End" ? tabs.length - 1
                  : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
                const nextTab = tabs[nextIndex];
                if (!nextTab) return;
                onSelectTab(nextTab.tab.id);
                getViewport()
                  ?.querySelector<HTMLElement>(`[data-session-tab-id="${CSS.escape(nextTab.tab.id)}"]`)
                  ?.focus();
              }}
            >
              {running && <span className="session-tab-dot" aria-hidden="true" />}
              <span className="session-tab-title">{title}</span>
              <button
                type="button"
                className="session-tab-close"
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(tab.id);
                }}
                title={t("sessionTab.close")}
                aria-label={`${t("sessionTab.close")} ${title}`}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <line x1="2" y1="2" x2="8" y2="8" />
                  <line x1="8" y1="2" x2="2" y2="8" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>

      {overflow.right && (
        <button
          type="button"
          className="tab-strip-scroll is-right"
          onClick={() => scrollBy(TAB_STRIP_SCROLL_STEP)}
          title={t("tabStrip.scrollRight")}
          aria-label={t("tabStrip.scrollRight")}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="9 6 15 12 9 18" />
          </svg>
        </button>
      )}

      {onNewTab && (
        <button
          type="button"
          className="session-tabs-new"
          onClick={onNewTab}
          title={t("sidebar.newSession")}
          aria-label={t("sidebar.newSession")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      )}
    </div>
  );
}
