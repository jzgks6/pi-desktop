"use client";

import { useCallback, useEffect, useState } from "react";

/** 两侧滚动按钮每次滚动的距离（约一个标签的宽度）。 */
export const TAB_STRIP_SCROLL_STEP = 180;

/**
 * 找一条标签栏的滚动视口。
 *
 * 抽成函数是因为右栏那条的视口是上游 `TabBar` 自己的根元素，fork 拿不到它的
 * ref，只能靠 className 找；滚动和拖动排序两个 hook 都要用它。
 */
export function findTabStripViewport(
  container: HTMLElement | null,
  viewportSelector: string,
): HTMLElement | null {
  return container?.querySelector<HTMLElement>(viewportSelector) ?? null;
}

interface Options {
  /**
   * 整条标签栏的最外层容器 —— **不是**滚动视口本身。
   * 视口在它里面，用 `viewportSelector` 找。
   */
  containerRef: React.RefObject<HTMLElement | null>;
  /** 真正做横向滚动的那个元素，相对容器查。 */
  viewportSelector: string;
  /** 活动项的选择器（在视口里查），用来把它滚进视野。 */
  activeSelector: string;
  /** 这个值一变就把活动项补滚进视野 —— 传「活动 id : 标签数」这种组合。 */
  revealKey: string;
  /** 标签数量。变了就重新观察子元素（新加的标签也要被观察到）。 */
  itemCount: number;
}

/**
 * 一条横向标签栏的滚动行为：两端箭头、滚轮映射成横向滚动、活动项自动进视野。
 *
 * 会话标签条（`SessionTabBar`）和右栏文件标签条（`FileTabStrip`）共用这一份实现。
 * 两处各写一遍太容易跑偏 —— 这里的边界条件都很脆：
 *
 * - 箭头显隐会改变视口宽度，而「该不该显箭头」又是从滚动位置算出来的。所以
 *   **绝不能在视口自身 resize 时去滚回活动项**，否则到右端卸载箭头 → 视口变宽
 *   → 又被拽回活动项 → 永远滑不到头。过滤条件见下面 ResizeObserver 里的
 *   `entries.some((entry) => entry.target !== el)`。
 * - 活动项补滚必须是 `inline: "nearest"` + 等一帧：标签刚插进 DOM 时滚动范围
 *   还没结算完，立刻滚会按错误的位置滚；而 `scrollIntoView` 会打断正在跑的平滑
 *   滚动（点箭头只挪十几像素就停住）。
 *
 * 视口用选择器找而不是收一个 ref：右栏那条的视口是上游 `TabBar.tsx` 自己的根
 * 元素，fork 只能给它加个 className，拿不到它的 ref。
 */
export function useTabStripScroll({
  containerRef,
  viewportSelector,
  activeSelector,
  revealKey,
  itemCount,
}: Options) {
  const [overflow, setOverflow] = useState({ left: false, right: false });

  const getViewport = useCallback(
    () => containerRef.current?.querySelector<HTMLElement>(viewportSelector) ?? null,
    [containerRef, viewportSelector],
  );

  const updateOverflow = useCallback(() => {
    const el = getViewport();
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setOverflow((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, [getViewport]);

  /** 把活动项滚进视野（已经看得见时是空操作）。 */
  const revealActive = useCallback(() => {
    getViewport()
      ?.querySelector<HTMLElement>(activeSelector)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [getViewport, activeSelector]);

  useEffect(() => {
    const el = getViewport();
    if (!el) return;
    updateOverflow();
    el.addEventListener("scroll", updateOverflow, { passive: true });
    const observer = new ResizeObserver((entries) => {
      updateOverflow();
      // 只有**标签自己**变尺寸（标题变长之类）才补滚；视口自身尺寸变化不补。
      if (entries.some((entry) => entry.target !== el)) revealActive();
    });
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => {
      el.removeEventListener("scroll", updateOverflow);
      observer.disconnect();
    };
  }, [getViewport, updateOverflow, revealActive, itemCount]);

  // 切到（或新开）一个标签后把它滚进视野 —— 否则新标签可能开在看不见的地方。
  useEffect(() => {
    const frame = requestAnimationFrame(revealActive);
    return () => cancelAnimationFrame(frame);
  }, [revealKey, revealActive]);

  const scrollBy = useCallback(
    (delta: number) => {
      getViewport()?.scrollBy({ left: delta, behavior: "smooth" });
    },
    [getViewport],
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLElement>) => {
      const el = getViewport();
      if (!el || el.scrollWidth <= el.clientWidth) return;
      // 纵向滚轮直接喂给横向滚动；横向滚轮（触控板）保持原样。
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (delta === 0) return;
      event.preventDefault();
      el.scrollLeft += delta;
    },
    [getViewport],
  );

  return { overflow, scrollBy, handleWheel, revealActive, getViewport };
}
