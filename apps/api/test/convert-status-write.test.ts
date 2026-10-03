import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { DB_PATH } from "../src/common/config.js";
import { filePathFor } from "../src/common/paths.js";
import { buildTestApp, type TestApp } from "./harness.js";

// Brief 67: a conversion's terminal status write that threw left the source row
// `running` with nothing running, and the install-wide slot (D34) refused every
// conversion until a restart. The write is now parked and replayed by the next
// convert or cancel. The failure here is a real SQLITE_BUSY: a second
// connection holds the write lock across the write.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixturePdf(title: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++) doc.addPage([300, 400]).drawText(`${title} page ${i + 1}`, { x: 40, y: 340, size: 16, font });
  return Buffer.from(await doc.save());
}

describe("a failed conversion status write cannot wedge conversions", () => {
  let t: TestApp;
  let cookie: string;
  const errors: string[] = [];
  const realError = console.error;

  const upload = async (title: string) => {
    const boundary = "----convertboundary";
    const res = await t.app.inject({
      method: "POST",
      url: "/library",
      headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${title}.pdf"\r\n` +
            `Content-Type: application/pdf\r\n\r\n`,
        ),
        await fixturePdf(title),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json().id as string;
  };
  const convert = (id: string) => t.app.inject({ method: "POST", url: `/library/${id}/convert`, headers: { cookie } });
  const cancel = (id: string) => t.app.inject({ method: "DELETE", url: `/library/${id}/convert`, headers: { cookie } });
  const status = async (id: string) =>
    (await t.app.inject({ method: "GET", url: `/library/${id}`, headers: { cookie } })).json().convertStatus as string;

  /** Hold SQLite's write lock from a second connection until `release()`. */
  const holdWriteLock = () => {
    const other = new Database(DB_PATH);
    other.exec("BEGIN IMMEDIATE");
    return () => {
      other.exec("ROLLBACK");
      other.close();
    };
  };

  const waitFor = async (check: () => boolean | Promise<boolean>, ms: number, what: string) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await check()) return;
    assert.fail(`timed out waiting for ${what}`);
  };

  before(async () => {
    t = await buildTestApp();
    cookie = t.ward.signIn("converter", "subject-converter");
    console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  });
  after(async () => {
    console.error = realError;
    await t.close();
  });

  it("a job's terminal write hits SQLITE_BUSY: logged with its code, and the next book still converts", async () => {
    const broken = await upload("Broken");
    const next = await upload("Next");
    // No source file: Calibre fails fast (or is missing), and either way the job
    // ends in a terminal `failed` write.
    rmSync(filePathFor(broken, "pdf"));

    const started = await convert(broken);
    assert.equal(started.statusCode, 202, started.body);
    const release = holdWriteLock();
    try {
      await waitFor(() => errors.some((e) => e.includes(broken)), 30_000, "the parked write");
    } finally {
      release();
    }
    assert.match(errors.find((e) => e.includes(broken))!, /SQLITE_BUSY/);
    assert.equal(await status(broken), "running", "the row is wedged until something replays it");

    const accepted = await convert(next);
    assert.equal(accepted.statusCode, 202, `another book was refused: ${accepted.body}`);
    assert.equal(await status(broken), "failed");

    await waitFor(async () => (await status(next)) !== "running", 120_000, "the real conversion");
    assert.ok(["ready", "poor"].includes(await status(next)), await status(next));
  });

  it("a cancel whose reset hits SQLITE_BUSY answers, and the next convert clears it", async () => {
    const book = await upload("Cancelled");
    const other = await upload("Afterwards");
    assert.equal((await convert(book)).statusCode, 202);

    const release = holdWriteLock();
    let res;
    try {
      res = await cancel(book);
    } finally {
      release();
    }
    assert.ok([200, 204].includes(res.statusCode), `cancel answered ${res.statusCode}: ${res.body}`);
    assert.ok(errors.some((e) => e.includes(book) && e.includes("reset")), "the parked reset was logged");

    // The child is gone; wait until the in-process job has let go.
    await waitFor(async () => (await convert(other)).statusCode !== 409, 30_000, "the slot");
    assert.equal(await status(book), "none");
    await waitFor(async () => (await status(other)) !== "running", 120_000, "the real conversion");
  });
});
