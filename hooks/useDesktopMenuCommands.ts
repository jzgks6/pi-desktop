"use client";

import { useEffect } from "react";

/**
 * 桌面壳（Tauri 外壳）原生菜单发过来的命令。
 *
 * macOS 上 ⌘T / ⌘W / ⌘N / ⌘, 会被**应用菜单**先吃掉，页面根本收不到 keydown,
 * 所以这几个快捷键只能在原生侧注册（`desktop/src-tauri/src/main.rs` 里那份菜单），
 * 由它用 `eval` 往当前窗口派发一个同名 CustomEvent，这里接住并转成已有的 handler。
 *
 * 为什么走 CustomEvent 而不引 Tauri 的 JS API：
 *  1. 网页这边不必因此背上 `@tauri-apps/api` 依赖（浏览器里这段就是纯 no-op）；
 *  2. desktop/ 与网页两侧的契约只剩「事件名」这一个字符串，符合
 *     FORK.md 里「桌面外壳与网页零耦合」那条。
 *
 * 改名时两边要一起改：这里是唯一一处列出事件名的地方，Rust 那边用
 * `MENU_EVENT_*` 常量与之对应。
 */
export const DESKTOP_MENU_EVENTS = {
  /** ⌘T：开一个空白新会话标签。 */
  newTab: "pi-desktop:new-tab",
  /** ⌘W：关掉当前标签（不是关窗口）。 */
  closeTab: "pi-desktop:close-tab",
  /** ⌘,：打开设置面板。 */
  settings: "pi-desktop:settings",
} as const;

interface DesktopMenuCommandOptions {
  onNewTab: () => void;
  onCloseTab: () => void;
  onOpenSettings: () => void;
}

/**
 * 订阅原生菜单命令。只在桌面壳里会真的收到事件；浏览器里注册了也不会有人派发。
 */
export function useDesktopMenuCommands({
  onNewTab,
  onCloseTab,
  onOpenSettings,
}: DesktopMenuCommandOptions): void {
  useEffect(() => {
    const commands: Array<[string, () => void]> = [
      [DESKTOP_MENU_EVENTS.newTab, onNewTab],
      [DESKTOP_MENU_EVENTS.closeTab, onCloseTab],
      [DESKTOP_MENU_EVENTS.settings, onOpenSettings],
    ];
    for (const [name, handler] of commands) window.addEventListener(name, handler);
    return () => {
      for (const [name, handler] of commands) window.removeEventListener(name, handler);
    };
  }, [onNewTab, onCloseTab, onOpenSettings]);
}
