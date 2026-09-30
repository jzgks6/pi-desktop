"use client";

import { useRef } from "react";
import { TabBar, type Tab } from "./TabBar";
import { useI18n } from "@/hooks/useI18n";
import { TAB_STRIP_SCROLL_STEP, useTabStripScroll } from "@/hooks/useTabStripScroll";
import { useTabStripDrag } from "@/hooks/useTabStripDrag";

interface Props {
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  /** 拖动排序：把 `fromIndex` 挪到 `toIndex`（移动**之后**的下标）。不传就不可拖。 */
  onReorder?: (fromIndex: number, toIndex: number) => void;
}

/**
 * 右栏头部的文件标签条：`TabBar` 外面套一层两端滚动按钮。
 *
 * 上游 `TabBar` 自己在标签过多时会画一条**系统滚动条**。那条滚动条是有高度的，
 * 会把下面那行文件标题（路径 · 行数 · 大小）整行挤下去 —— 桌面 app 窗口里尤其难看，
 * 所以这里把它隐掉（`app/native-theme.css` 里的 `.file-tabs`），
 * 换成会和会话标签条同一套逻辑：只在确实溢出的一侧显形箭头、滚轮映射成横向滚动、
 * 按住标签左右拖可以排序。
 *
 * 滚动 / 拖动的动作全部由 `useTabStripScroll` + `useTabStripDrag` 提供，视口就是
 * `TabBar` 自己的根元素（`.file-tabs`，fork 只给它加了这一个 className，见 FORK.md
 * 的改上游规则）。两处都靠选择器找元素、靠事件委托接手势，因为上游组件的 JSX 里
 * 加不了 `onPointerDown` / `data-*`。
 *
 * 这里额外套一层 `.tab-strip-viewport` 是有原因的：`TabBar` 的根元素带着
 * `flexShrink: 0`（inline style，fork 覆盖不了），直接当 `.tab-strip` 的 flex 子项
 * 会拒绝收缩、把右侧箭头挤出可视区。
 */
export function FileTabStrip({ tabs, activeTabId, onSelectTab, onCloseTab, onReorder }: Props) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { overflow, scrollBy, handleWheel } = useTabStripScroll({
    containerRef,
    viewportSelector: ".file-tabs",
    activeSelector: '[role="tab"][aria-selected="true"]',
    revealKey: `${activeTabId}:${tabs.length}`,
    itemCount: tabs.length,
  });
  const { handleContainerPointerDown } = useTabStripDrag({
    containerRef,
    viewportSelector: ".file-tabs",
    itemSelector: '[role="tab"]',
    onReorder,
    // 标签里的关闭按钮上按下不算拖（那是点击）。
    ignoreTarget: (target) => !!target.closest("button"),
  });

  return (
    <div
      className="tab-strip"
      ref={containerRef}
      onWheel={handleWheel}
      onPointerDown={handleContainerPointerDown}
    >
      {/* 到端点就卸载，不留空位（与会话标签条一致）。 */}
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
      <div className="tab-strip-viewport">
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={onSelectTab}
          onCloseTab={onCloseTab}
        />
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
    </div>
  );
}
