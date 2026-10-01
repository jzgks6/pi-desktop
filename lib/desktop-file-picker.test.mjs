import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  baseNameOfPath,
  hasDesktopFilePicker,
  pickFilesWithDesktopDialog,
  sniffImageMime,
} = await jiti.import("./desktop-file-picker.ts");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const BMP = new Uint8Array([0x42, 0x4d, 0, 0]);

test("sniffs only the image types pi can actually ingest", () => {
  assert.equal(sniffImageMime(PNG), "image/png");
  assert.equal(sniffImageMime(JPEG), "image/jpeg");
  assert.equal(sniffImageMime(GIF), "image/gif");
  assert.equal(sniffImageMime(WEBP), "image/webp");
  assert.equal(sniffImageMime(BMP), "image/bmp");
  // PDF、zip、纯文本、空文件都不是图片 —— 它们走 @路径，不进图片通道。
  assert.equal(sniffImageMime(new Uint8Array([0x25, 0x50, 0x44, 0x46])), null);
  assert.equal(sniffImageMime(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), null);
  assert.equal(sniffImageMime(new TextEncoder().encode("hello")), null);
  assert.equal(sniffImageMime(new Uint8Array()), null);
});

test("takes the file name out of a path instead of the whole path", () => {
  assert.equal(baseNameOfPath("/Users/x/report.pdf"), "report.pdf");
  assert.equal(baseNameOfPath("/Users/x/项目/生而为赢.pdf"), "生而为赢.pdf");
  assert.equal(baseNameOfPath("plain.txt"), "plain.txt");
});

test("falls back to the file input when there is no Tauri IPC", async () => {
  assert.equal(hasDesktopFilePicker(), false);
  assert.equal(await pickFilesWithDesktopDialog(), null);
});

test("opens the native dialog through the Tauri IPC and returns plain paths", async () => {
  const calls = [];
  globalThis.__TAURI_INTERNALS__ = {
    invoke(command, args) {
      calls.push({ command, args });
      return Promise.resolve(["/Users/x/a.pdf", "/Users/x/b.png"]);
    },
  };
  try {
    assert.equal(hasDesktopFilePicker(), true);
    assert.deepEqual(await pickFilesWithDesktopDialog("附加文件"), ["/Users/x/a.pdf", "/Users/x/b.png"]);
    assert.equal(calls[0].command, "plugin:dialog|open");
    assert.equal(calls[0].args.options.multiple, true);
    assert.equal(calls[0].args.options.directory, false);
    assert.equal(calls[0].args.options.title, "附加文件");
  } finally {
    delete globalThis.__TAURI_INTERNALS__;
  }
});

test("treats a cancelled dialog as an empty selection", async () => {
  globalThis.__TAURI_INTERNALS__ = { invoke: () => Promise.resolve(null) };
  try {
    assert.deepEqual(await pickFilesWithDesktopDialog(), []);
  } finally {
    delete globalThis.__TAURI_INTERNALS__;
  }
});
