import { crc32, createDeflateRaw, deflateRawSync } from "node:zlib";

/**
 * A minimal zip writer for crafted EPUBs (brief 64). An entry is either real
 * bytes or `zeros(n)`: n zero bytes compressed as a stream, so an entry that
 * truly inflates to gigabytes (and says so in its headers) costs a few MB of
 * archive and never a gigabyte of memory to build.
 */

export interface Zeros {
  zeros: number;
}

export type EntryContent = Buffer | string | Zeros;

interface Built {
  name: Buffer;
  method: number;
  crc: number;
  compressed: Buffer;
  size: number;
}

async function deflateZeros(total: number): Promise<{ compressed: Buffer; crc: number }> {
  const chunk = Buffer.alloc(1024 * 1024);
  const deflate = createDeflateRaw({ level: 9 });
  const out: Buffer[] = [];
  deflate.on("data", (b: Buffer) => out.push(b));
  const done = new Promise<void>((resolve, reject) => {
    deflate.on("end", resolve);
    deflate.on("error", reject);
  });
  let crc = 0;
  for (let left = total; left > 0; left -= chunk.length) {
    const piece = left >= chunk.length ? chunk : chunk.subarray(0, left);
    crc = crc32(piece, crc);
    if (!deflate.write(piece)) await new Promise((resolve) => deflate.once("drain", resolve));
  }
  deflate.end();
  await done;
  return { compressed: Buffer.concat(out), crc };
}

async function build(name: string, content: EntryContent, stored: boolean): Promise<Built> {
  if (typeof content === "object" && !Buffer.isBuffer(content)) {
    const { compressed, crc } = await deflateZeros(content.zeros);
    return { name: Buffer.from(name), method: 8, crc, compressed, size: content.zeros };
  }
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return stored
    ? { name: Buffer.from(name), method: 0, crc: crc32(bytes), compressed: bytes, size: bytes.length }
    : { name: Buffer.from(name), method: 8, crc: crc32(bytes), compressed: deflateRawSync(bytes), size: bytes.length };
}

/** Build a zip from `[name, content]` pairs, in order. The first entry named `mimetype` is stored. */
export async function buildZip(entries: [string, EntryContent][]): Promise<Buffer> {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const e = await build(name, content, name === "mimetype");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(e.method, 8);
    header.writeUInt32LE(e.crc >>> 0, 14);
    header.writeUInt32LE(e.compressed.length, 18);
    header.writeUInt32LE(e.size, 22);
    header.writeUInt16LE(e.name.length, 26);
    local.push(header, e.name, e.compressed);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(e.method, 10);
    dir.writeUInt32LE(e.crc >>> 0, 16);
    dir.writeUInt32LE(e.compressed.length, 20);
    dir.writeUInt32LE(e.size, 24);
    dir.writeUInt16LE(e.name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, e.name);
    offset += header.length + e.name.length + e.compressed.length;
  }
  const dirBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, dirBytes, end]);
}

export const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

export const opf = (title: string, author: string) => `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${title}</dc:title><dc:creator>${author}</dc:creator>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest><item id="cover-img" href="cover.png" media-type="image/png" properties="cover-image"/></manifest>
</package>`;

/**
 * A PNG whose header declares `width × height` but carries almost no pixel
 * data: what a decoder sees first, and all a pixel limit needs to refuse it.
 */
export function pngHeaderOnly(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateRawSync(Buffer.alloc(64))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
