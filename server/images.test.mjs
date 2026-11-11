// run with: node --experimental-transform-types --test
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { IMAGE_LIMITS, checkImages, imagesNote, layoutFor, saveImages } from "./core.ts";

const png = (bytes) => ({ name: "截图.png", mimeType: "image/png", data: Buffer.alloc(bytes, 1).toString("base64") });

test("images within the limits pass", () => {
  assert.doesNotThrow(() => checkImages([png(1000), png(2000)]));
  assert.doesNotThrow(() => checkImages([]));
});

test("too many, too large, or unsupported images are refused with a reason", () => {
  assert.throws(() => checkImages(Array.from({ length: IMAGE_LIMITS.count + 1 }, () => png(10))), /最多附/);
  assert.throws(() => checkImages([png(IMAGE_LIMITS.bytes + 1024)]), /单张上限/);
  assert.throws(() => checkImages([png(4 * 1024 * 1024), png(4 * 1024 * 1024), png(4 * 1024 * 1024 + 4096)]), /合计/);
  assert.throws(() => checkImages([{ mimeType: "image/svg+xml", data: "AAAA" }]), /不支持的图片格式/);
});

test("images are saved under the dispatcher's 附件/<lane>/ with their bytes intact", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "dispatch-images-"));
  const layout = layoutFor(home);
  const image = png(64);
  const files = saveImages(layout, "global", "l1", [image, { ...image, name: undefined, mimeType: "image/jpeg" }], new Date("2026-11-10T03:04:05Z"));
  assert.equal(files.length, 2);
  assert.equal(path.dirname(files[0]), path.join(home, "调度员", "global", "附件", "l1"));
  assert.match(path.basename(files[0]), /^20261110-030405-1-截图\.png$/);
  assert.match(path.basename(files[1]), /^20261110-030405-2\.jpg$/);
  assert.deepEqual(readFileSync(files[0]), Buffer.from(image.data, "base64"));
});

test("the dispatcher is told where the images are and to pass paths to workers", () => {
  assert.equal(imagesNote([]), "");
  const note = imagesNote(["/a/1.png", "/a/2.png"]);
  assert.match(note, /附了 2 张图/);
  assert.match(note, /- \/a\/1\.png/);
  assert.match(note, /任务卡/);
});
