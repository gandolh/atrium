import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { extractMeta } from "../src/modules/library/extract.service.js";
import { buildTestApp, type TestApp } from "./harness.js";
import { CONTAINER, buildZip, opf, pngHeaderOnly, type EntryContent } from "./zip-builder.js";

// Brief 64: EPUB extraction inflated three entries with no ceiling but the one
// each entry declares. A truthful zip bomb declares its size honestly, and
// `inflateRawSync` blocks the event loop while it inflates. Each entry is now
// refused on its declared size before anything is inflated.

const MB = 1024 * 1024;

const epub = (parts: { container?: EntryContent; opf?: EntryContent; cover?: EntryContent }) =>
  buildZip([
    ["mimetype", "application/epub+zip"],
    ["META-INF/container.xml", parts.container ?? CONTAINER],
    ["OEBPS/content.opf", parts.opf ?? opf("A Real Title", "An Author")],
    ["OEBPS/cover.png", parts.cover ?? Buffer.alloc(0)],
  ]);

/**
 * Run `fn`, returning its value and the refusals it logged. The log line is the
 * proof the entry was refused on its declared size: inflating 64 MB of zeros
 * is quick, so timing alone could not tell a refusal from an inflation.
 */
async function refusals<T>(fn: () => Promise<T>): Promise<[T, string[]]> {
  const logged: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void logged.push(args.join(" "));
  try {
    return [await fn(), logged.filter((line) => line.includes("refused EPUB entry"))];
  } finally {
    console.warn = realWarn;
  }
}

describe("EPUB extraction refuses to inflate past its own ceilings", () => {
  let cover: Buffer;

  before(async () => {
    cover = await sharp({ create: { width: 300, height: 450, channels: 3, background: "#336699" } })
      .png()
      .toBuffer();
  });

  it("an ordinary EPUB still yields title, author and cover", async () => {
    const meta = await extractMeta(await epub({ cover }), "epub", "file-name.epub");
    assert.equal(meta.title, "A Real Title");
    assert.equal(meta.author, "An Author");
    assert.ok(meta.cover && meta.cover.length > 0, "cover extracted");
  });

  it("a container.xml that truly inflates to 64 MB is refused: filename title, no cover", async () => {
    const bomb = await epub({ container: { zeros: 64 * MB }, cover });
    const [meta, refused] = await refusals(() => extractMeta(bomb, "epub", "file-name.epub"));
    assert.equal(meta.title, "file-name");
    assert.equal(meta.cover, null);
    assert.equal(refused.length, 1);
    assert.match(refused[0], /META-INF\/container\.xml.*declares 67108864 bytes/);
  });

  it("an OPF over 8 MB is refused the same way", async () => {
    const bomb = await epub({ opf: { zeros: 16 * MB }, cover });
    const [meta, refused] = await refusals(() => extractMeta(bomb, "epub", "file-name.epub"));
    assert.equal(meta.title, "file-name");
    assert.equal(meta.cover, null);
    assert.match(refused[0] ?? "", /content\.opf/);
  });

  it("a cover entry over 32 MB is refused, and the OPF's metadata is kept", async () => {
    const bomb = await epub({ cover: { zeros: 64 * MB } });
    const [meta, refused] = await refusals(() => extractMeta(bomb, "epub", "file-name.epub"));
    assert.equal(meta.title, "A Real Title");
    assert.equal(meta.author, "An Author");
    assert.equal(meta.cover, null);
    assert.match(refused[0] ?? "", /cover\.png/);
  });

  it("a cover whose header declares 30,000 × 30,000 pixels is refused before decoding", async () => {
    const meta = await extractMeta(await epub({ cover: pngHeaderOnly(30_000, 30_000) }), "epub", "file-name.epub");
    assert.equal(meta.title, "A Real Title");
    assert.equal(meta.cover, null);
  });

  it("a real 64 MP cover, decodable under sharp's ~268 MP default, is refused by the 40 MP limit", async () => {
    const huge = await sharp({ create: { width: 8000, height: 8000, channels: 3, background: "#808080" } })
      .png({ compressionLevel: 1 })
      .toBuffer();
    const meta = await extractMeta(await epub({ cover: huge }), "epub", "file-name.epub");
    assert.equal(meta.title, "A Real Title");
    assert.equal(meta.cover, null);
  });
});

describe("a refused EPUB is still a book", () => {
  let t: TestApp;

  before(async () => {
    t = await buildTestApp();
  });
  after(async () => {
    await t.close();
  });

  it("uploads with the filename title and no cover", async () => {
    const cookie = t.ward.signIn("reader", "subject-reader");
    const bomb = await epub({ container: { zeros: 64 * MB } });
    const boundary = "----bombboundary";
    const res = await t.app.inject({
      method: "POST",
      url: "/library",
      headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Pathological.epub"\r\n` +
            `Content-Type: application/epub+zip\r\n\r\n`,
        ),
        bomb,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().title, "Pathological");
    assert.equal(res.json().hasCover, false);
  });
});
