import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  attachmentsDir,
  sanitizeAttachmentFileName,
  stagedAttachmentName,
  uniqueAttachmentName,
} = await jiti.import("./attachment-staging.ts");

test("stages attachments outside the project, under ~/.pi/attachments", () => {
  assert.equal(attachmentsDir("/Users/example"), "/Users/example/.pi/attachments");
});

test("strips path separators and control characters from staged file names", () => {
  assert.equal(sanitizeAttachmentFileName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeAttachmentFileName("/tmp/some dir/report.pdf"), "report.pdf");
  assert.equal(sanitizeAttachmentFileName("C:\\Users\\x\\evil.txt"), "evil.txt");
  assert.equal(sanitizeAttachmentFileName("we\u0000ird\u001f.txt"), "weird.txt");
  assert.equal(sanitizeAttachmentFileName(".env"), "env");
  assert.equal(sanitizeAttachmentFileName(""), "file");
  assert.equal(sanitizeAttachmentFileName("...."), "file");
});

test("prefixes a timestamp so the staging directory stays readable", () => {
  const now = new Date(2026, 8, 30, 23, 59, 5);
  assert.equal(stagedAttachmentName("report.pdf", now), "20260930-235905-report.pdf");
});

test("keeps multi-byte file names within the filesystem limit", () => {
  const name = `${"中".repeat(200)}.txt`;
  const safe = sanitizeAttachmentFileName(name);
  assert.ok(Buffer.byteLength(safe) <= 180, `${Buffer.byteLength(safe)} bytes`);
  assert.ok(safe.endsWith(".txt"), safe);
});

test("deduplicates names staged in the same second", () => {
  const taken = new Set(["20260930-235905-a.pdf"]);
  assert.equal(
    uniqueAttachmentName("20260930-235905-a.pdf", (candidate) => taken.has(candidate)),
    "20260930-235905-a-2.pdf",
  );
  taken.add("20260930-235905-a-2.pdf");
  assert.equal(
    uniqueAttachmentName("20260930-235905-a.pdf", (candidate) => taken.has(candidate)),
    "20260930-235905-a-3.pdf",
  );
});
