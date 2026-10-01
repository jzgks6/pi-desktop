/**
 * 非图片附件的「@路径」处理（fork）。
 *
 * 规则只有两条，保持一致：
 *
 *   · **图片** —— 走上游原来的通道（客户端压缩 + 缩略图 + `images` 参数）；
 *   · **其它一切**（PDF、docx、zip、小文本…）—— 一律只写 `@绝对路径`，一个字节
 *     都不进模型上下文，让模型用它自己的本地工具去读。
 *
 * 路径从哪来：
 *   · 桌面壳（app）—— 原生文件选择窗口直接给真实路径，**不拷贝、无大小上限**
 *     （`kind: "link"`）；
 *   · 普通浏览器 —— WebView 拿不到路径，只能把文件拷一份到 `~/.pi/attachments/`
 *     再引用副本（`kind: "local"`，见 `lib/attachment-staging.ts`），因此那条路
 *     仍有暂存上限。
 */
import { getImageMime } from "./file-types";

/** 图片仍然用上游的上限（10MB，客户端还会压缩）。 */
export const MAX_ATTACHED_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * 浏览器里「拷贝暂存」那条路的单文件上限（app 里走原生路径不受此限）。
 */
export const MAX_LOCAL_FILE_BYTES = 100 * 1024 * 1024;

/**
 * `local` —— 浏览器里挑的：拷了一份到 `~/.pi/attachments/`（受暂存上限约束）；
 * `link`  —— 桌面壳原生对话框挑的：**不拷贝**，直接引用原路径（**无大小上限**）。
 */
export type AttachmentFileKind = "local" | "link";

/** 非图片附件的草稿形态（内存草稿 + 发送失败时的恢复都用它）。 */
export interface ChatDraftFile {
  kind: AttachmentFileKind;
  /** 文件名，用于附件卡片。 */
  name: string;
  /** 原始字节数（仅用于显示；link 不因此受限）。 */
  size: number;
  /** 绝对路径（发送时以 `@路径` 形式给出）。 */
  path: string;
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
  if (file.kind !== "local" && file.kind !== "link") return false;
  if (typeof file.name !== "string" || file.name.length === 0) return false;
  if (typeof file.path !== "string" || file.path.length === 0) return false;
  if (typeof file.size !== "number" || !Number.isFinite(file.size) || file.size < 0) return false;
  // `link` 引用的是用户自己选的原始文件（不拷贝、不上限）；
  // `local` 是浏览器里暂存的那份副本，仍需守住暂存上限。
  return file.kind === "link" || file.size <= MAX_LOCAL_FILE_BYTES;
}

/**
 * 图片判定：优先用浏览器给的 MIME。拿不到 MIME 时按扩展名兜底。
 * SVG 排除在外 —— 它是文本，各家 provider 都不把它当图片收，走 `@路径` 更好。
 */
export function isImageAttachmentFile(type: string | undefined, name: string): boolean {
  const mime = (type ?? "").toLowerCase();
  if (mime === "image/svg+xml") return false;
  if (mime.startsWith("image/")) return true;
  if (mime) return false;
  return getImageMime(name) !== null;
}

export type AttachmentFileClassification = { kind: "image" } | { kind: "local" };

/** 给一个文件分类：图片交回上游的图片通道，其余一律走「本地路径」。 */
export function classifyAttachmentFile(input: {
  name: string;
  type?: string;
  bytes: Uint8Array;
}): AttachmentFileClassification {
  if (isImageAttachmentFile(input.type, input.name)) return { kind: "image" };
  return { kind: "local" };
}

/** pi 的 `@路径` 提及形式（每条一行）。 */
export function formatLocalFileMention(path: string): string {
  return `@${path}\n`;
}

/**
 * 拼出真正发给模型的正文：`@路径` 在前、用户输入在后（与 pi 的
 * `buildInitialMessage` 顺序一致）。图片不在这一层，走 `images` 参数。
 */
export function composeOutgoingMessage(text: string, files: ChatDraftFile[] | undefined): string {
  if (!files || files.length === 0) return text;
  const mentions = files.map((file) => formatLocalFileMention(file.path)).join("");
  if (!mentions) return text;
  return text ? `${mentions}${text}` : mentions.trimEnd();
}

/**
 * 把文件落到本地暂存目录（服务端写入 `~/.pi/attachments/`），返回绝对路径。
 * 只有普通浏览器需要它 —— 桌面壳用原生路径，不拷贝。
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

export interface InspectedPathFile {
  path: string;
  name: string;
  size: number;
  kind: "image" | "file";
  mimeType?: string;
  data?: string;
  error?: string;
}

/**
 * 把桌面壳选中的路径交给服务端识别：图片会带回 base64（走原来的图片通道），
 * 其它类型只回元数据（网页只写 `@路径`，字节不过网）。
 */
export async function inspectPickedPaths(paths: string[]): Promise<InspectedPathFile[]> {
  const response = await fetch("/api/attachments/inspect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  const payload = await response.json().catch(() => null) as
    | { files?: InspectedPathFile[]; error?: unknown }
    | null;
  if (!response.ok) {
    const error = typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`;
    throw new Error(error);
  }
  return Array.isArray(payload?.files) ? payload.files : [];
}

/** 把 base64 还原成 `File`，让图片重新走一遍上游的压缩 + 预览通道。 */
export function fileFromBase64(name: string, mimeType: string, data: string): File {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], name, { type: mimeType });
}
