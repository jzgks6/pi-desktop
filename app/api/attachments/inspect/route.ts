/**
 * POST /api/attachments/inspect —— 按**路径**识别桌面壳选中的文件（fork）。
 *
 * 请求：`{ paths: string[] }`（来自原生文件选择对话框的绝对路径）。
 * 响应：`{ files: [{ path, name, size, kind, mimeType?, data?, error? }] }`
 *   · `kind: "image"` → 带回 base64（只在 ≤10MB 且魔数是图片时），网页据此走原来的图片通道
 *   · `kind: "file"`  → **不回传任何字节**，网页只写 `@路径`（因此这条没有大小上限）
 *
 * 安全面：只在这台机器上、只回本地来源（`isApiRequestAllowed`），并且**只**可能回图片内容；
 * 其它类型连字节都不读。这跟桌面壳本身的能力一致（它本来就能读本机任意文件）。
 */
import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

import { MAX_ATTACHED_IMAGE_BYTES } from "@/lib/image-attachments";
import { sniffImageMime } from "@/lib/desktop-file-picker";
import { isApiRequestAllowed } from "@/lib/request-security";

/** 只读头部这么多字节来做魔数嗅探。 */
const SNIFF_BYTES = 4096;
const MAX_PATHS = 50;

interface InspectedFile {
  path: string;
  name: string;
  size: number;
  kind: "image" | "file";
  mimeType?: string;
  data?: string;
  error?: string;
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const body = await request.json().catch(() => null) as { paths?: unknown } | null;
  const paths = Array.isArray(body?.paths)
    ? body.paths.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
  if (paths.length === 0) {
    return NextResponse.json({ error: "paths must be a non-empty array of strings" }, { status: 400 });
  }
  if (paths.length > MAX_PATHS) {
    return NextResponse.json({ error: `At most ${MAX_PATHS} paths per request` }, { status: 400 });
  }

  const files: InspectedFile[] = [];
  for (const filePath of paths) {
    const name = path.basename(filePath);
    try {
      const stats = await fs.stat(filePath);
      if (!stats.isFile()) {
        files.push({ path: filePath, name, size: 0, kind: "file", error: "not a file" });
        continue;
      }

      const handle = await fs.open(filePath, "r");
      let head: Buffer;
      try {
        head = Buffer.alloc(Math.min(SNIFF_BYTES, stats.size));
        await handle.read(head, 0, head.length, 0);
      } finally {
        await handle.close();
      }

      const mimeType = sniffImageMime(head);
      // 图片走原来的图片通道；其它一切（含小文本）只给 `@路径` —— 与浏览器侧规则一致。
      if (!mimeType || stats.size > MAX_ATTACHED_IMAGE_BYTES) {
        files.push({ path: filePath, name, size: stats.size, kind: "file" });
        continue;
      }

      const bytes = await fs.readFile(filePath);
      files.push({
        path: filePath,
        name,
        size: stats.size,
        kind: "image",
        mimeType,
        data: bytes.toString("base64"),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      files.push({ path: filePath, name, size: 0, kind: "file", error: message });
    }
  }

  return NextResponse.json({ files });
}
