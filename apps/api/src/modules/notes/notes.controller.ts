import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createNoteFolderSchema,
  createNoteSchema,
  moveNoteSchema,
  noteFolderListSchema,
  noteFolderSchema,
  noteListSchema,
  noteSchema,
  updateNoteFolderSchema,
  updateNoteSchema,
} from "@ebook-reader/shared";
import { pdfFilename, renderNotePdf } from "./note-pdf.service.js";
import { toFolder, toNote, toSummary } from "./notes.mapper.js";
import {
  canonicalNote,
  createFolder,
  createNote,
  listProfileFolders,
  listProfileNotes,
  moveNote,
  readNote,
  removeFolder,
  removeNote,
  saveNote,
  updateFolder,
} from "./notes.service.js";

/**
 * HTTP for notes and note folders (briefs 26, 50). Per-profile since brief 35
 * (D35, decision 3): every handler passes `request.authProfile` into the
 * service, and the app-wide guard has already 401'd anything without one, so no
 * route here does its own auth.
 */
export function registerNotesRoutes(app: FastifyInstance): void {
  // The guard guarantees an authProfile on every route here.
  const pid = (request: FastifyRequest): string => request.authProfile!.id;

  app.get("/notes", async (request: FastifyRequest, reply: FastifyReply) => {
    const rows = await listProfileNotes(pid(request));
    return reply.send(noteListSchema.parse(rows.map(toSummary)));
  });

  app.post("/notes", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = createNoteSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "INVALID_REQUEST" });
    const row = await createNote(pid(request), parsed.data.title);
    return reply.status(201).send(noteSchema.parse(toNote(row)));
  });

  app.get("/notes/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const row = await readNote(pid(request), id);
    if (!row) return reply.status(404).send({ error: "NOT_FOUND" });
    return reply.send(noteSchema.parse(toNote(row)));
  });

  /**
   * PDF export (brief 49) — all pages, vector, rendered by `note-pdf.service`.
   *
   * It reads the note through the profile-scoped `readNote`, exactly like
   * `GET /notes/:id` above: the profile scope is part of the lookup, not a
   * check bolted on after it, so a note on another profile is a 404 here for
   * the same reason it is there. An export route that read by id alone would be
   * a read of someone else's notebook.
   */
  app.get("/notes/:id/export.pdf", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const row = await readNote(pid(request), id);
    if (!row) return reply.status(404).send({ error: "NOT_FOUND" });
    const note = canonicalNote(row);
    const bytes = await renderNotePdf(note.title, note.pages);
    const ascii = pdfFilename(note.title);
    return reply
      .header("Content-Type", "application/pdf")
      .header(
        "Content-Disposition",
        `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(
          `${note.title || "note"}.pdf`,
        )}`,
      )
      .send(Buffer.from(bytes));
  });

  app.patch("/notes/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = updateNoteSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "INVALID_REQUEST" });
    const { id } = request.params as { id: string };
    const row = await saveNote(pid(request), id, {
      title: parsed.data.title,
      pages: parsed.data.pages,
    });
    if (!row) return reply.status(404).send({ error: "NOT_FOUND" });
    return reply.send(noteSchema.parse(toNote(row)));
  });

  app.delete("/notes/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    if (!(await removeNote(pid(request), id))) {
      return reply.status(404).send({ error: "NOT_FOUND" });
    }
    return reply.status(204).send();
  });

  /**
   * File a note into a folder — `{"folderId": null}` lifts it back to the root.
   *
   * Its own route rather than a field on `PATCH /notes/:id` (brief 50): that
   * route is the editor's autosave, firing many times a minute with the whole
   * page set, and a move must not be something a save can undo by racing it.
   */
  app.patch("/notes/:id/folder", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = moveNoteSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "INVALID_REQUEST" });
    const { id } = request.params as { id: string };
    const result = await moveNote(pid(request), id, parsed.data.folderId);
    if (!result.ok) return reply.status(404).send({ error: "NOT_FOUND" });
    return reply.send(noteSchema.parse(toNote(result.note)));
  });

  /* -----------------------------------------------------------------------
   * Note folders (brief 50)
   *
   * Mounted at `/note-folders`, NOT `/notes/folders`. Fastify would in fact
   * route the static segment ahead of `/notes/:id`, but a resource whose
   * correctness depends on router priority against a sibling parametric route
   * is a trap for whoever adds the next `/notes/...` path. A separate root
   * makes "folders are not a note" true in the URL space too.
   * -------------------------------------------------------------------- */

  app.get("/note-folders", async (request: FastifyRequest, reply: FastifyReply) => {
    const rows = await listProfileFolders(pid(request));
    return reply.send(noteFolderListSchema.parse(rows.map(toFolder)));
  });

  app.post("/note-folders", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = createNoteFolderSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "INVALID_REQUEST" });
    const row = await createFolder(pid(request), parsed.data);
    if (!row) return reply.status(404).send({ error: "NOT_FOUND" });
    return reply.status(201).send(noteFolderSchema.parse(toFolder(row)));
  });

  app.patch("/note-folders/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = updateNoteFolderSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "INVALID_REQUEST" });
    const { id } = request.params as { id: string };
    const result = await updateFolder(pid(request), id, parsed.data);
    if (!result.ok) {
      if (result.reason === "CYCLE") return reply.status(400).send({ error: "FOLDER_CYCLE" });
      return reply.status(404).send({ error: "NOT_FOUND" });
    }
    return reply.send(noteFolderSchema.parse(toFolder(result.folder)));
  });

  app.delete("/note-folders/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    if (!(await removeFolder(pid(request), id))) {
      return reply.status(404).send({ error: "NOT_FOUND" });
    }
    return reply.status(204).send();
  });
}
