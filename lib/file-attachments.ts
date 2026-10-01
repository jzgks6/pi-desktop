/**
 * 非图片附件的识别与注入（fork）。
 *
 * 上游的附件通道只有图片（pi 的 `prompt(text, images)` 只收 `ImageContent`），
 * 所以 composer 里的「附加文件」走两条路：
 *
 *   1. 文本类（UTF-8 能解码、不含 NUL）→ 直接注入消息正文，包成 pi 自己的
 *      `<file name="…">内容</file>` 形式（与 pi CLI 的 `@file` 完全一致，
 *      见 pi-coding-agent 的 `cli/file-processor.js`）。任何模型都能真读到。
 *   2. 其它（PDF/docx/xlsx/zip…）→ 原始字节**不进**模型上下文，只在本地暂存
 *      （`~/.pi/attachments/`，见 `lib/attachment-staging.ts`），消息里给一个
 *      `@绝对路径`，让模型用它自己的本地工具去读。
 *
 * 图片仍然走原来的 images 通道（压缩 + 缩略图），这里不碰。
 */
import { TEXT_PREVIEW_MAX_BYTES, getImageMime } from "./file-types";

/** 图片仍然用上游的上限（10MB，客户端还会压缩）。 */
export const MAX_ATTACHED_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * 「本地文件」那条路（不占上下文，只是拷一份到本机）的单个文件上限。
 * 比图片大得多 —— 大文件正是这条路存在的理由。
 */
export const MAX_LOCAL_FILE_BYTES = 100 * 1024 * 1024;

/**
 * 超过这个大小的文本文件不再注入正文，改走「本地文件 + @路径」。
 * 10MB 的文本注入正文会直接把上下文顶爆，所以这里跟预览上限保持一致（256KB）。
 */
export const MAX_INLINE_TEXT_BYTES = TEXT_PREVIEW_MAX_BYTES;

export type AttachmentFileKind = "text" | "local";

/** 非图片附件的草稿形态（内存草稿 + 发送失败时的恢复都用它）。 */
export interface ChatDraftFile {
  kind: AttachmentFileKind;
  /** 原始文件名，用于 `<file name>` 与附件卡片。 */
  name: string;
  /** 原始字节数。 */
  size: number;
  /** `kind === "text"`：已解码的正文（发送时注入消息）。 */
  text?: string;
  /** `kind === "local"`：本地暂存后的绝对路径（发送时以 @路径 形式给出）。 */
  path?: string;
}

export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unitIndex]}`;
}

export function isChatDraftFile(value: unknown): value is ChatDraftFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<ChatDraftFile>;
  if (file.kind !== "text" && file.kind !== "local") return false;
  if (typeof file.name !== "string" || file.name.length === 0) return false;
  if (typeof file.size !== "number" || !Number.isFinite(file.size) || file.size < 0) return false;
  if (file.kind === "text") {
    return typeof file.text === "string" && file.size <= MAX_INLINE_TEXT_BYTES;
  }
  return typeof file.path === "string" && file.path.length > 0 && file.size <= MAX_LOCAL_FILE_BYTES;
}

/**
 * 图片判定：优先用浏览器给的 MIME。拿不到 MIME 时按扩展名兜底。
 * SVG 排除在外 —— 它是文本，各家 provider 都不把它当图片收。
 */
export function isImageAttachmentFile(type: string | undefined, name: string): boolean {
  const mime = (type ?? "").toLowerCase();
  if (mime === "image/svg+xml") return false;
  if (mime.startsWith("image/")) return true;
  if (mime) return false;
  return getImageMime(name) !== null;
}

const TEXT_SNIFF_BYTES = 8192;

/**
 * 二进制嗅探：看文件头有没有 NUL，以及是不是合法 UTF-8。
 * 只做判定，不产出文本 —— 大文件不必为此解码整份内容。
 */
export function looksLikeTextBytes(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  const sample = bytes.subarray(0, TEXT_SNIFF_BYTES);
  if (sample.includes(0)) return false;

  // 样例可能正好截断在多字节字符中间：退 1~3 字节再试。
  for (let trim = 0; trim <= 3 && trim < sample.length; trim += 1) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(sample.subarray(0, sample.length - trim));
      return true;
    } catch {
      // 继续退
    }
  }
  return false;
}

/** 按 UTF-8 解码并去掉 BOM（与 pi 的 `stripBom` 行为一致）。 */
export function decodeTextBytes(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8").decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** pi 的 `<file>` 文本块，格式与 `cli/file-processor.js` 逐字对齐。 */
export function formatFileTextBlock(name: string, content: string): string {
  return `<file name="${name}">\n${content}\n</file>\n`;
}

/** 本地文件引用：pi 的 `@路径` 提及形式。 */
export function formatLocalFileMention(path: string): string {
  return `@${path}\n`;
}

/**
 * 把文件落到本地暂存目录（服务端写入 `~/.pi/attachments/`），返回绝对路径。
 * 原始字节不进模型上下文，消息里只给这个路径。
 */
export async function stageAttachmentFile(file: File): Promise<string> {
  const body = new FormData();
  body.append("files", file);
  const response = await fetch("/api/attachments", { method: "POST", body });
  const payload = await response.json().catch(() => null) as
    | { files?: { path?: unknown }[]; error?: unknown }
    | null;
  if (!response.ok) {
    const error = typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`;
    throw new Error(error);
  }
  const path = payload?.files?.[0]?.path;
  if (typeof path !== "string" || !path) throw new Error("staging returned no path");
  return path;
}

export type AttachmentFileClassification =
  | { kind: "image" }
  | { kind: "text"; text: string }
  | { kind: "local" };

/**
 * 给一个文件分类：图片交回上游的图片通道，文本注入正文，其它作为本地文件引用。
 */
export function classifyAttachmentFile(input: {
  name: string;
  type?: string;
  bytes: Uint8Array;
}): AttachmentFileClassification {
  if (isImageAttachmentFile(input.type, input.name)) return { kind: "image" };
  if (input.bytes.byteLength <= MAX_INLINE_TEXT_BYTES && looksLikeTextBytes(input.bytes)) {
    return { kind: "text", text: decodeTextBytes(input.bytes) };
  }
  return { kind: "local" };
}

/**
 * 拼出真正发给模型的正文：附件块在前、用户输入在后（与 pi 的
 * `buildInitialMessage` 顺序一致）。图片不在这一层，走 `images` 参数。
 */
export function composeOutgoingMessage(text: string, files: ChatDraftFile[] | undefined): string {
  if (!files || files.length === 0) return text;
  const blocks = files
    .map((file) => (file.kind === "text"
      ? formatFileTextBlock(file.name, file.text ?? "")
      : file.path
        ? formatLocalFileMention(file.path)
        : ""))
    .join("");
  if (!blocks) return text;
  return text ? `${blocks}${text}` : blocks.trimEnd();
}
