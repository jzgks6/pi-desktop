/**
 * POST /api/attachments —— 暂存「附加文件」里的非文本文件（fork）。
 *
 * 请求：multipart/form-data，字段名 `files`（可多个）。
 * 响应：`{ files: [{ name, path, size }] }`，`path` 是 `~/.pi/attachments/` 下的绝对路径。
 *
 * 只落盘、不回传内容：消息里给模型一个 `@路径`，由它自己的本地工具去读。
 */
import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

import {
  MAX_STAGED_FILE_BYTES,
  MAX_STAGED_FILES,
  MAX_STAGED_REQUEST_BYTES,
  attachmentsDir,
  stagedAttachmentName,
  uniqueAttachmentName,
} from "@/lib/attachment-staging";
import { RequestBodyTooLargeError, parseFormDataWithinLimit } from "@/lib/bounded-form-data";
import { isApiRequestAllowed } from "@/lib/request-security";

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  let formData: FormData;
  try {
    formData = await parseFormDataWithinLimit(request, MAX_STAGED_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Attachments are too large" }, { status: 413 });
    }
    throw error;
  }

  const files = formData.getAll("files").filter((entry): entry is File => typeof entry !== "string");
  if (files.length === 0) {
    return NextResponse.json({ error: "files is required" }, { status: 400 });
  }
  if (files.length > MAX_STAGED_FILES) {
    return NextResponse.json({ error: `At most ${MAX_STAGED_FILES} files per request` }, { status: 400 });
  }
  for (const file of files) {
    if (file.size > MAX_STAGED_FILE_BYTES) {
      return NextResponse.json(
        { error: `Each file must be ${MAX_STAGED_FILE_BYTES / (1024 * 1024)}MB or smaller` },
        { status: 413 },
      );
    }
  }

  const directory = attachmentsDir();
  try {
    await fs.mkdir(directory, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `Could not create ${directory}: ${message}` }, { status: 500 });
  }

  const staged: { name: string; path: string; size: number }[] = [];
  const taken = new Set<string>();
  for (const file of files) {
    const stamp = new Date();
    const name = uniqueAttachmentName(stagedAttachmentName(file.name, stamp), (candidate) => taken.has(candidate));
    const target = path.join(directory, name);
    try {
      await fs.writeFile(target, Buffer.from(await file.arrayBuffer()));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ error: `Could not write ${target}: ${message}` }, { status: 500 });
    }
    taken.add(name);
    staged.push({ name: file.name, path: target, size: file.size });
  }

  return NextResponse.json({ files: staged });
}
