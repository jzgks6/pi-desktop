import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  MAX_INLINE_TEXT_BYTES,
  MAX_LOCAL_FILE_BYTES,
  classifyAttachmentFile,
  composeOutgoingMessage,
  decodeTextBytes,
  formatAttachmentSize,
  formatFileTextBlock,
  isChatDraftFile,
  isImageAttachmentFile,
  looksLikeTextBytes,
} = await jiti.import("./file-attachments.ts");

const bytesOf = (text) => new TextEncoder().encode(text);

test("sniffs text files by NUL bytes and UTF-8 validity", () => {
  assert.equal(looksLikeTextBytes(bytesOf("hello")), true);
  assert.equal(looksLikeTextBytes(bytesOf("中文文本\n第二行")), true);
  assert.equal(looksLikeTextBytes(new Uint8Array()), true);
  assert.equal(looksLikeTextBytes(new Uint8Array([0x68, 0x00, 0x69])), false);
  // 0xff 在 UTF-8 里永远非法 —— PDF、png 这类二进制都会踩到。
  assert.equal(looksLikeTextBytes(new Uint8Array([0xff, 0xfe, 0x41])), false);
  // 样例恰好截断在多字节字符中间时仍算文本。
  const truncated = bytesOf("中文").subarray(0, 5);
  assert.equal(looksLikeTextBytes(truncated), true);
});

test("decodes text bytes and strips a BOM like pi does", () => {
  assert.equal(decodeTextBytes(bytesOf("plain")), "plain");
  assert.equal(decodeTextBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])), "a");
});

test("formats the file block exactly like pi's @file handling", () => {
  assert.equal(
    formatFileTextBlock("report.md", "# 标题"),
    '<file name="report.md">\n# 标题\n</file>\n',
  );
});

test("classifies images, text files and everything else", () => {
  assert.deepEqual(
    classifyAttachmentFile({ name: "shot.png", type: "image/png", bytes: new Uint8Array([1, 2]) }),
    { kind: "image" },
  );
  // 浏览器给不出 MIME 时按扩展名兜底。
  assert.deepEqual(
    classifyAttachmentFile({ name: "shot.png", type: "", bytes: new Uint8Array([1, 2]) }),
    { kind: "image" },
  );
  // SVG 是文本，不走图片通道。
  assert.deepEqual(
    classifyAttachmentFile({ name: "icon.svg", type: "image/svg+xml", bytes: bytesOf("<svg/>") }),
    { kind: "text", text: "<svg/>" },
  );
  assert.deepEqual(
    classifyAttachmentFile({ name: "notes.md", type: "text/markdown", bytes: bytesOf("# hi") }),
    { kind: "text", text: "# hi" },
  );
  assert.deepEqual(
    classifyAttachmentFile({ name: "doc.pdf", type: "application/pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00]) }),
    { kind: "local" },
  );
});

test("oversized text files fall back to the local-file route", () => {
  const big = new Uint8Array(MAX_INLINE_TEXT_BYTES + 1);
  big.fill(0x61);
  assert.deepEqual(classifyAttachmentFile({ name: "huge.log", type: "text/plain", bytes: big }), { kind: "local" });
});

test("composes the outgoing message with attachment blocks before the typed text", () => {
  assert.equal(composeOutgoingMessage("看下这个", []), "看下这个");
  assert.equal(composeOutgoingMessage("看下这个", undefined), "看下这个");

  const text = composeOutgoingMessage("看下这个", [
    { kind: "text", name: "a.md", size: 3, text: "hi" },
  ]);
  assert.equal(text, '<file name="a.md">\nhi\n</file>\n看下这个');

  const local = composeOutgoingMessage("", [
    { kind: "local", name: "doc.pdf", size: 10, path: "/Users/x/.pi/attachments/20260930-120000-doc.pdf" },
  ]);
  assert.equal(local, "@/Users/x/.pi/attachments/20260930-120000-doc.pdf");

  const mixed = composeOutgoingMessage("问：总结一下", [
    { kind: "text", name: "a.md", size: 3, text: "hi" },
    { kind: "local", name: "doc.pdf", size: 10, path: "/tmp/doc.pdf" },
  ]);
  assert.equal(mixed, '<file name="a.md">\nhi\n</file>\n@/tmp/doc.pdf\n问：总结一下');
});

test("treats SVG and unknown types as non-images", () => {
  assert.equal(isImageAttachmentFile("image/png", "a.png"), true);
  assert.equal(isImageAttachmentFile("", "a.png"), true);
  assert.equal(isImageAttachmentFile("image/svg+xml", "a.svg"), false);
  assert.equal(isImageAttachmentFile("application/pdf", "a.pdf"), false);
  assert.equal(isImageAttachmentFile("", "a.pdf"), false);
});

test("validates draft file entries", () => {
  assert.equal(isChatDraftFile({ kind: "text", name: "a.md", size: 1, text: "x" }), true);
  assert.equal(isChatDraftFile({ kind: "local", name: "a.pdf", size: 1, path: "/tmp/a.pdf" }), true);
  // 本地文件那条路不计上下文，上限宽松得多。
  assert.equal(isChatDraftFile({ kind: "local", name: "big.zip", size: 50 * 1024 * 1024, path: "/tmp/big.zip" }), true);
  assert.equal(isChatDraftFile({ kind: "local", name: "huge.zip", size: MAX_LOCAL_FILE_BYTES + 1, path: "/tmp/huge.zip" }), false);
  // 注入正文的那条路刚好相反：超过内联上限就不该是 text。
  assert.equal(isChatDraftFile({ kind: "text", name: "big.md", size: MAX_INLINE_TEXT_BYTES + 1, text: "x" }), false);
  assert.equal(isChatDraftFile({ kind: "text", name: "a.md", size: 1 }), false);
  assert.equal(isChatDraftFile({ kind: "local", name: "a.pdf", size: 1 }), false);
  assert.equal(isChatDraftFile({ kind: "nope", name: "a", size: 1, text: "" }), false);
  assert.equal(isChatDraftFile({ kind: "text", name: "", size: 1, text: "x" }), false);
  assert.equal(isChatDraftFile(null), false);
});

test("formats attachment sizes for the chip label", () => {
  assert.equal(formatAttachmentSize(0), "0 B");
  assert.equal(formatAttachmentSize(999), "999 B");
  assert.equal(formatAttachmentSize(2048), "2 KB");
  assert.equal(formatAttachmentSize(10 * 1024 * 1024), "10 MB");
});
