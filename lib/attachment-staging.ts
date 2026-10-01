/**
 * 附件暂存（fork，仅服务端）。
 *
 * 「附加文件」里的非图片、非文本文件不把原始字节塞进模型上下文，而是落到
 * `~/.pi/attachments/` 下的一个副本，消息里只给 `@绝对路径`，让模型用它自己的
 * 本地工具去读（`read` 工具对绝对路径没有工作区限制，`resolveToCwd` 会原样放行）。
 *
 * 放在 `~/.pi/` 而不是会话工作区里，是为了不污染项目目录（不乱入 git 状态）。
 */
import { homedir } from "os";
import path from "path";

/** 单个附件的上限：比图片宽松得多 —— 这条路只是拷一份到本机，不占模型上下文。 */
export const MAX_STAGED_FILE_BYTES = 100 * 1024 * 1024;
/** 一次请求最多这么多文件（前端一次也不会超过附件总数上限）。 */
export const MAX_STAGED_FILES = 10;
export const MAX_STAGED_REQUEST_BYTES = 200 * 1024 * 1024;
/** 文件名保留的字节数（含时间戳前缀后仍远低于 255 的系统上限）。 */
export const MAX_FILE_NAME_BYTES = 180;

export function attachmentsDir(home: string = homedir()): string {
  return path.join(home, ".pi", "attachments");
}

/** 文件名里剔掉路径分隔符、控制字符和首尾点，避免写出目录之外或生成隐藏文件。 */
export function sanitizeAttachmentFileName(name: string): string {
  const base = path.basename(name).replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/^[.\s]+/, "").trim();
  const safe = cleaned.replace(/[\\/]/g, "-");
  if (!safe) return "file";
  // macOS/Linux 单段文件名上限 255 字节，中文按多字节算，留出时间戳前缀的余量。
  if (Buffer.byteLength(safe) <= MAX_FILE_NAME_BYTES) return safe;

  // 截断也要把扩展名留下来 —— 模型和系统靠它认类型。
  const ext = path.extname(safe).slice(0, 16);
  const stem = path.basename(safe, path.extname(safe));
  const budget = Math.max(1, MAX_FILE_NAME_BYTES - Buffer.byteLength(ext));
  const cut = Buffer.from(stem).subarray(0, budget).toString("utf8").replace(/\uFFFD+$/, "");
  return `${cut || "file"}${ext}`;
}

/** `20260930-235900-report.pdf`：时间戳前缀让暂存目录可读，也天然避免重名。 */
export function stagedAttachmentName(name: string, now: Date = new Date()): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${sanitizeAttachmentFileName(name)}`;
}

/** 同一秒拖进两个同名文件时加 `-2`、`-3` 后缀。 */
export function uniqueAttachmentName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem}-${index}${ext}`;
    if (!taken(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}
