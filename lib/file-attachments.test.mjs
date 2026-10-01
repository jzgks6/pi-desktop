import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  MAX_LOCAL_FILE_BYTES,
  classifyAttachmentFile,
  composeOutgoingMessage,
  fileFromBase64,
  formatAttachmentSize,
  isChatDraftFile,
  isImageAttachmentFile,
} = await jiti.import("./file-attachments.ts");

const bytesOf = (text) => new TextEncoder().encode(text);

test("classifies images for the upstream pipeline and everything else as a local path", () => {
  assert.deepEqual(
    classifyAttachmentFile({ name: "shot.png", type: "image/png", bytes: new Uint8Array([1, 2]) }),
    { kind: "image" },
  );
  // 浏览器给不出 MIME 时按扩展名兜底。
  assert.deepEqual(
    classifyAttachmentFile({ name: "shot.png", type: "", bytes: new Uint8Array([1, 2]) }),
    { kind: "image" },
  );
  // 非图片一律走 @路径 —— 包括小文本（规则只有两条，保持一致）。
  assert.deepEqual(
    classifyAttachmentFile({ name: "doc.pdf", type: "application/pdf", bytes: new Uint8Array([0x25]) }),
    { kind: "local" },
  );
  assert.deepEqual(
    classifyAttachmentFile({ name: "notes.md", type: "text/markdown", bytes: bytesOf("# hi") }),
    { kind: "local" },
  );
  // SVG 是文本，不走图片通道。
  assert.deepEqual(
    classifyAttachmentFile({ name: "icon.svg", type: "image/svg+xml", bytes: bytesOf("<svg/>") }),
    { kind: "local" },
  );
});

test("treats SVG and unknown types as non-images", () => {
  assert.equal(isImageAttachmentFile("image/png", "a.png"), true);
  assert.equal(isImageAttachmentFile("", "a.png"), true);
  assert.equal(isImageAttachmentFile("image/svg+xml", "a.svg"), false);
  assert.equal(isImageAttachmentFile("application/pdf", "a.pdf"), false);
  assert.equal(isImageAttachmentFile("", "a.pdf"), false);
});

test("composes the outgoing message with @path mentions before the typed text", () => {
  assert.equal(composeOutgoingMessage("看下这个", []), "看下这个");
  assert.equal(composeOutgoingMessage("看下这个", undefined), "看下这个");

  // link：原生对话框选中的原文件 —— 不拷贝、不设限，只写 @路径。
  const link = composeOutgoingMessage("总结一下", [
    { kind: "link", name: "生而为赢.pdf", size: 2 * 1024 * 1024 * 1024, path: "/Users/x/生而为赢.pdf" },
  ]);
  assert.equal(link, "@/Users/x/生而为赢.pdf\n总结一下");

  // local：浏览器里暂存的那份副本，同样只写 @路径。
  const local = composeOutgoingMessage("", [
    { kind: "local", name: "doc.pdf", size: 10, path: "/Users/x/.pi/attachments/20260930-120000-doc.pdf" },
  ]);
  assert.equal(local, "@/Users/x/.pi/attachments/20260930-120000-doc.pdf");

  const mixed = composeOutgoingMessage("问：总结一下", [
    { kind: "local", name: "a.md", size: 3, path: "/tmp/a.md" },
    { kind: "link", name: "b.pdf", size: 4, path: "/tmp/b.pdf" },
  ]);
  assert.equal(mixed, "@/tmp/a.md\n@/tmp/b.pdf\n问：总结一下");
});

test("validates draft file entries", () => {
  assert.equal(isChatDraftFile({ kind: "local", name: "a.pdf", size: 1, path: "/tmp/a.pdf" }), true);
  // 本地暂存那条路仍有上限。
  assert.equal(isChatDraftFile({ kind: "local", name: "big.zip", size: 50 * 1024 * 1024, path: "/tmp/big.zip" }), true);
  assert.equal(isChatDraftFile({ kind: "local", name: "huge.zip", size: MAX_LOCAL_FILE_BYTES + 1, path: "/tmp/huge.zip" }), false);
  // link（原生对话框选的原始文件）不拷贝、不设上限：3GB 的引用也是合法的。
  assert.equal(isChatDraftFile({ kind: "link", name: "movie.mov", size: 3 * 1024 * 1024 * 1024, path: "/Users/x/movie.mov" }), true);
  assert.equal(isChatDraftFile({ kind: "link", name: "movie.mov", size: 1 }), false);
  assert.equal(isChatDraftFile({ kind: "nope", name: "a", size: 1, path: "/tmp/a" }), false);
  assert.equal(isChatDraftFile({ kind: "local", name: "", size: 1, path: "/tmp/a" }), false);
  assert.equal(isChatDraftFile(null), false);
});

test("rebuilds a File from base64 so images go through the upstream pipeline", () => {
  const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  const file = fileFromBase64("shot.png", "image/png", data);
  assert.equal(file.name, "shot.png");
  assert.equal(file.type, "image/png");
  assert.equal(file.size, 4);
});

test("formats attachment sizes for the chip label", () => {
  assert.equal(formatAttachmentSize(0), "0 B");
  assert.equal(formatAttachmentSize(999), "999 B");
  assert.equal(formatAttachmentSize(2048), "2 KB");
  assert.equal(formatAttachmentSize(10 * 1024 * 1024), "10 MB");
});
