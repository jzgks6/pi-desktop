/**
 * 原生文件选择器 + 按路径识别的纯函数（fork）。
 *
 * 为什么要有这一层：WebView 里的 `<input type=file>` **拿不到文件的真实路径**，
 * 没有路径就只能把字节拷一份给服务端 —— 那就必然要给一个大小上限。桌面壳给的是
 * 真路径，所以：
 *
 *   · 图片：从路径读回字节（`/api/attachments/inspect`），交给原来的图片通道
 *     （压缩 + 缩略图 + `images`），跟以前完全一样；
 *   · 其它类型：一个字节都不传，只写 `@原路径`，让模型用自己的本地工具去读。
 *     **没有大小上限**（这条路本来就不占上下文）。
 */

/** 只看头部字节就能认出来的图片类型（与 pi 支持的一致，BMP 由 pi 侧转 PNG）。 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return "image/bmp";
  }
  return null;
}

/** 从路径里取文件名（仅用于展示与 `<file name>`）。 */
export function baseNameOfPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1) || normalized;
}

interface TauriInternals {
  invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

function tauriInternals(): TauriInternals | null {
  const internals = (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  return internals && typeof internals.invoke === "function" ? internals : null;
}

/** 桌面壳（Tauri）里才有的原生文件选择窗口；普通浏览器里返回 false，调用方回落 `<input type=file>`。 */
export function hasDesktopFilePicker(): boolean {
  return tauriInternals() !== null;
}

/**
 * 打开原生多选文件对话框。
 * 返回绝对路径数组；用户取消返回 `[]`；不在桌面壳里返回 `null`。
 */
export async function pickFilesWithDesktopDialog(title?: string): Promise<string[] | null> {
  const internals = tauriInternals();
  if (!internals?.invoke) return null;
  const result = await internals.invoke("plugin:dialog|open", {
    options: {
      multiple: true,
      directory: false,
      ...(title ? { title } : {}),
    },
  });
  if (result === null || result === undefined) return [];
  if (!Array.isArray(result)) return [];
  return result.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (entry && typeof entry === "object") {
      const candidate = entry as { path?: unknown; url?: unknown };
      if (typeof candidate.path === "string") return [candidate.path];
    }
    return [];
  });
}
