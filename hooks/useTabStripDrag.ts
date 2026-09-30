"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { findTabStripViewport } from "./useTabStripScroll";

/** 按住之后先跨过这个距离才算「在拖」，否则当成普通点击。 */
export const TAB_DRAG_THRESHOLD = 4;
/** 重排时其它标签滑到新位置的时长；松手后那个「滑回槽位」也用它。 */
export const TAB_FLIP_MS = 160;
/** 被拖的那个标签挂这个类（lift 阴影 / cursor 由 CSS 给）。 */
const DRAGGING_CLASS = "is-dragging";

interface DragState {
  node: HTMLElement;
  /** 是否已经越过阈值、真的在拖了。 */
  moved: boolean;
  /** 按下时的指针 x，用来判阈值。 */
  startX: number;
  /** 指针相对标签左边缘的位置（抓住哪儿就保持抓哪儿）。 */
  grabOffsetX: number;
  /** `offsetLeft` 的基准：视口左边缘在屏幕上的位置。拖动期间视口不会横向移动，量一次就够。 */
  baseLeft: number;
  /** 被拖的标签此刻应该待在的屏幕左边缘。 */
  desiredLeft: number;
}

interface Options {
  /** 整条标签栏的最外层容器（与 useTabStripScroll 同一个 ref）。 */
  containerRef: React.RefObject<HTMLElement | null>;
  /** 滚动视口（相对容器查），与 useTabStripScroll 同一个值。 */
  viewportSelector: string;
  /** 可拖的项（相对视口查）。 */
  itemSelector: string;
  /** 把 fromIndex 挪到 toIndex —— **移动之后**的下标，与 `moveTab` 同一套语义。 */
  onReorder?: (fromIndex: number, toIndex: number, node: HTMLElement) => void;
  /** 这个按下不算拖（例如关闭按钮）。 */
  ignoreTarget?: (target: HTMLElement) => boolean;
}

/**
 * 横向标签栏的「按住拖动排序」。会话标签条与右栏文件标签条共用。
 *
 * 手感目标：被拖的那个**贴着指针走**，它让出来的那个空位就是落点，其它标签滑到
 * 新位置。没有这一段的话标签是硬跳的，拖到哪儿了根本看不出来。
 *
 * 几个关键取舍：
 *
 * - **按 DOM 节点工作，不依赖任何 id / data 属性。** 右栏的标签是上游 `TabBar`
 *   渲染的，fork 只能给它加一个 className，既拿不到 ref 也加不了 `data-*`。
 *   所以项的身份就是节点本身（FLIP 的旧位置存在 `WeakMap<Element, number>` 里）。
 * - **两种入口都支持**：逐项绑（`handleItemPointerDown`，会话标签条）和事件委托
 *   （`handleContainerPointerDown`，右栏不能改上游 JSX）。两条最后走同一个
 *   `beginDrag`。
 * - **监听器挂 window，不挂标签自己。** 重排会让 React 把节点在 DOM 里搬家，
 *   `setPointerCapture` 在这种元素上不保证还持有捕获（中途丢捕获就断在半个拖动上）。
 * - **FLIP 用 WAAPI（`node.animate`），不用 CSS 过渡。** 右栏标签的 `transition`
 *   是上游写的 inline 值（只有 background / color），inline 压过样式表，fork
 *   加不进 `transform`；所以这里统一用动画，顺带也不用再玩「设 transition:none →
 *   强制回流 → 还原」那一套。
 * - **量位置一律用 `offsetLeft`**：它是布局值，不受 transform 影响，可以在动画
 *   进行中安全地读（`getBoundingClientRect()` 读到的是正在动的位置，会越算越歪）。
 * - **`preventDefault()` 是必须的。** 否则从标签上拖出去时，WebKit（app 里的
 *   WKWebView）会去找最近的可选文本当锚点，把鼠标划过的文字选上。拖完那一下
 *   click 由容器上的 capture 监听吞掉 —— 右栏的 click 处理是上游的，读不到我们的
 *   抑制标志，只能在半路把事件截下来。
 */
export function useTabStripDrag({
  containerRef,
  viewportSelector,
  itemSelector,
  onReorder,
  ignoreTarget,
}: Options) {
  const suppressClickRef = useRef(false);
  const dragRef = useRef<DragState | null>(null);
  const lastLeftsRef = useRef(new WeakMap<Element, number>());
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  const getViewport = useCallback(
    () => findTabStripViewport(containerRef.current, viewportSelector),
    [containerRef, viewportSelector],
  );

  const getItems = useCallback(
    () => Array.from(getViewport()?.querySelectorAll<HTMLElement>(itemSelector) ?? []),
    [getViewport, itemSelector],
  );

  /**
   * 指针该插到第几个位置。
   *
   * 只跟**其它**标签比：被拖的那个跟着指针走，它的矩形早就不是它的槽位了，
   * 拿它一起比会把落点算歪（向右拖会提前换位 / 不换位）。
   * 返回值就是 `moveTab` 要的 `toIndex`：把被拖项从列表里拿出来后，它该插回去的下标。
   */
  const dropIndexAtX = useCallback(
    (clientX: number, dragged: HTMLElement): number => {
      const viewport = getViewport();
      if (!viewport) return -1;
      const others = Array.from(viewport.querySelectorAll<HTMLElement>(itemSelector)).filter(
        (node) => node !== dragged,
      );
      if (others.length === 0) return 0;
      const viewportLeft = viewport.getBoundingClientRect().left - viewport.scrollLeft;
      let index = 0;
      for (const node of others) {
        const middle = viewportLeft + node.offsetLeft + node.offsetWidth / 2;
        if (clientX < middle) return index;
        index += 1;
      }
      return index;
    },
    [getViewport, itemSelector],
  );

  /** 让被拖的标签贴着指针：transform = 指针希望它在的位置 − 它当前的槽位。 */
  const applyDragTransform = useCallback((drag: DragState) => {
    const slotLeft = drag.baseLeft + drag.node.offsetLeft;
    drag.node.style.transform = `translateX(${drag.desiredLeft - slotLeft}px)`;
  }, []);

  const beginDrag = useCallback(
    (event: React.PointerEvent, node: HTMLElement) => {
      if (!onReorderRef.current || event.button !== 0) return;
      if (ignoreTarget?.(event.target as HTMLElement)) return;
      const items = getItems();
      // 一个标签没什么可排的，也免得跟点击抢手势。
      if (items.length < 2 || !items.includes(node)) return;

      // 见文件头：押掉默认动作，别让 WebKit 去锚选文字。
      event.preventDefault();

      const rect = node.getBoundingClientRect();
      const drag: DragState = {
        node,
        moved: false,
        startX: event.clientX,
        grabOffsetX: event.clientX - rect.left,
        baseLeft: rect.left - node.offsetLeft,
        desiredLeft: rect.left,
      };
      dragRef.current = drag;

      const handleMove = (moveEvent: PointerEvent) => {
        if (!drag.moved) {
          if (Math.abs(moveEvent.clientX - drag.startX) < TAB_DRAG_THRESHOLD) return;
          drag.moved = true;
          suppressClickRef.current = true;
          node.classList.add(DRAGGING_CLASS);
        }
        drag.desiredLeft = moveEvent.clientX - drag.grabOffsetX;

        const toIndex = dropIndexAtX(moveEvent.clientX, node);
        const current = getItems().indexOf(node);
        if (toIndex !== -1 && current !== -1 && toIndex !== current) {
          // 先记下落点再重排：重排后的 layout effect 会据此把它重新贴回指针。
          onReorderRef.current?.(current, toIndex, node);
        }
        // 这里读到的 offsetLeft 可能还是重排前那个（state 更新是异步的），但重排
        // 完成后 layout effect 会再算一次，所以不会歪。
        applyDragTransform(drag);
      };

      const finish = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        const wasDragging = drag.moved;
        dragRef.current = null;
        if (!wasDragging) return;
        node.classList.remove(DRAGGING_CLASS);

        // 松手后滑回它自己的槽位。用动画而不是清掉 inline transform 交给 CSS：
        // 上游那条 inline transition 里没有 transform，靠 CSS 表达不了。
        const offset = -node.offsetLeft + (drag.desiredLeft - drag.baseLeft);
        node.style.transform = "";
        if (Math.abs(offset) > 0.5) {
          node.animate(
            [{ transform: `translateX(${offset}px)` }, { transform: "none" }],
            { duration: TAB_FLIP_MS, easing: "ease" },
          );
        }
        // click 在 pointerup 之后同步派发，所以下一个宏任务里再解除屏蔽就刚好。
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [applyDragTransform, dropIndexAtX, getItems, ignoreTarget],
  );

  /** 逐项绑定的入口（会话标签条：每项自己挂 onPointerDown）。 */
  const handleItemPointerDown = useCallback(
    (event: React.PointerEvent) => beginDrag(event, event.currentTarget as HTMLElement),
    [beginDrag],
  );

  /** 事件委托的入口（右栏标签条：上游的 JSX 改不了，只能在容器上接）。 */
  const handleContainerPointerDown = useCallback(
    (event: React.PointerEvent) => {
      const target = event.target as HTMLElement;
      const item = target.closest<HTMLElement>(itemSelector);
      if (!item || item === containerRef.current || !getItems().includes(item)) return;
      beginDrag(event, item);
    },
    [beginDrag, containerRef, getItems, itemSelector],
  );

  /**
   * 重排后让其它标签**滑**到新位置（FLIP：先瞬移回旧位置，再动画到新位置）。
   *
   * 没写依赖数组：每次 commit 都得比一次，而重排本身不改变项数（依赖项数是不够的）。
   * 位置没动时 delta 为 0，直接跳过，所以平时几乎不花代价。
   */
  useLayoutEffect(() => {
    const drag = dragRef.current;
    for (const node of getItems()) {
      const previous = lastLeftsRef.current.get(node);
      const current = node.offsetLeft;
      if (previous === undefined || previous === current) continue;
      const delta = previous - current;
      // 被拖的那个不参与 FLIP：它要一直贴在指针上。
      if (!(drag?.moved && drag.node === node) && Math.abs(delta) >= 0.5) {
        node.animate(
          [{ transform: `translateX(${delta}px)` }, { transform: "none" }],
          { duration: TAB_FLIP_MS, easing: "ease" },
        );
      }
    }
    for (const node of getItems()) lastLeftsRef.current.set(node, node.offsetLeft);
  });

  /**
   * 拖完那一下 click 要吞掉，否则松手会顺手切一次标签。
   *
   * 监听在**捕获阶段**、挂在容器上：右栏的 click 处理是上游写死的
   * （`onClick={() => onSelectTab(tab.id)}`），读不到这里的抑制标志，
   * 只能在事件往上走到 React 根节点之前把它截下来。
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const swallow = (event: Event) => {
      if (!suppressClickRef.current) return;
      event.stopPropagation();
      event.preventDefault();
    };
    container.addEventListener("click", swallow, true);
    return () => container.removeEventListener("click", swallow, true);
  }, [containerRef]);

  return { handleItemPointerDown, handleContainerPointerDown, suppressClickRef };
}
