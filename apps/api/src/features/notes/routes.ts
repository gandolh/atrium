import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
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
import { NOTE_MAX_BYTES } from "../../config.js";
import { pdfFilename, renderNotePdf } from "./note-pdf.service.js";
import { toFolder, toNote, toSummary } from "./mapper.js";
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
} from "./service.js";
import { present } from "../../lib/present.js";
import { errorBody } from "../../plugins/errors.js";

const idParams = z.object({ id: z.string() });

/**
 * HTTP for notes and note folders. Per-profile since the profiles work
 * (D35, decision 3): every handler passes `request.authProfile` into the
 * service, and the app-wide guard has already 401'd anything without one, so no
 * route here does its own auth.
 */
export const notesRoutes: FastifyPluginAsyncZod = async (app) => {
  // The guard guarantees an authProfile on every route here.
  const pid = (request: FastifyRequest): string => present(request.authProfile, "the profile the guard resolved").id;

  /**
   * The note body routes' size ceiling. An autosave carries the whole
   * notebook, so Fastify's 1 MiB default was a wall a real notebook would hit.
   * Over the cap the answer is a stable code the editor can name, not
   * Fastify's generic 413, because "this note is too large to save" is the one
   * failure retrying will never fix.
   */
  const noteBody = {
    bodyLimit: NOTE_MAX_BYTES,
    errorHandler: (error: Error & { code?: string }, _request: FastifyRequest, reply: FastifyReply) => {
      if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
        return reply.status(413).send({ error: "NOTE_TOO_LARGE" });
      }
      return reply.send(error);
    },
  };

  app.get("/notes", { schema: { response: { 200: noteListSchema } } }, async (request) => {
    const rows = await listProfileNotes(pid(request));
    return rows.map(toSummary);
  });

  // No body at all is a note with the default title, as `{}` is.
  app.post(
    "/notes",
    { ...noteBody, schema: { body: createNoteSchema.nullish(), response: { 201: noteSchema, 413: errorBody } } },
    async (request, reply) => {
      const row = await createNote(pid(request), request.body?.title);
      return reply.status(201).send(toNote(row));
    },
  );

  app.get(
    "/notes/:id",
    { schema: { params: idParams, response: { 200: noteSchema, 404: errorBody } } },
    async (request, reply) => {
      const row = await readNote(pid(request), request.params.id);
      if (!row) return reply.status(404).send({ error: "NOT_FOUND" });
      return reply.send(toNote(row));
    },
  );

  /**
   * PDF export — all pages, vector, rendered by `note-pdf.service`. A binary
   * reply, so no response schema (scripts/conventions.json).
   *
   * It reads the note through the profile-scoped `readNote`, exactly like
   * `GET /notes/:id` above: the profile scope is part of the lookup, not a
   * check bolted on after it, so a note on another profile is a 404 here for
   * the same reason it is there. An export route that read by id alone would be
   * a read of someone else's notebook.
   */
  app.get("/notes/:id/export.pdf", { schema: { params: idParams } }, async (request, reply) => {
    const row = await readNote(pid(request), request.params.id);
    if (!row) return reply.status(404).send({ error: "NOT_FOUND" });
    const note = canonicalNote(row);
    const bytes = await renderNotePdf(note.title, note.pages);
    const ascii = pdfFilename(note.title);
    return reply
      .header("Content-Type", "application/pdf")
      .header(
        "Content-Disposition",
        `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(`${note.title || "note"}.pdf`)}`,
      )
      .send(Buffer.from(bytes));
  });

  app.patch(
    "/notes/:id",
    {
      ...noteBody,
      schema: {
        params: idParams,
        body: updateNoteSchema,
        response: { 200: noteSchema, 404: errorBody, 413: errorBody },
      },
    },
    async (request, reply) => {
      const row = await saveNote(pid(request), request.params.id, {
        title: request.body.title,
        pages: request.body.pages,
      });
      if (!row) return reply.status(404).send({ error: "NOT_FOUND" });
      return reply.send(toNote(row));
    },
  );

  app.delete(
    "/notes/:id",
    { schema: { params: idParams, response: { 204: z.null(), 404: errorBody } } },
    async (request, reply) => {
      if (!(await removeNote(pid(request), request.params.id))) {
        return reply.status(404).send({ error: "NOT_FOUND" });
      }
      return reply.status(204).send(null);
    },
  );

  /**
   * File a note into a folder — `{"folderId": null}` lifts it back to the root.
   *
   * Its own route rather than a field on `PATCH /notes/:id`: that
   * route is the editor's autosave, firing many times a minute with the whole
   * page set, and a move must not be something a save can undo by racing it.
   */
  app.patch(
    "/notes/:id/folder",
    { schema: { params: idParams, body: moveNoteSchema, response: { 200: noteSchema, 404: errorBody } } },
    async (request, reply) => {
      const result = await moveNote(pid(request), request.params.id, request.body.folderId);
      if (!result.ok) return reply.status(404).send({ error: "NOT_FOUND" });
      return reply.send(toNote(result.note));
    },
  );

  /* -----------------------------------------------------------------------
   * Note folders
   *
   * Mounted at `/note-folders`, NOT `/notes/folders`. Fastify would in fact
   * route the static segment ahead of `/notes/:id`, but a resource whose
   * correctness depends on router priority against a sibling parametric route
   * is a trap for whoever adds the next `/notes/...` path. A separate root
   * makes "folders are not a note" true in the URL space too.
   * -------------------------------------------------------------------- */

  app.get("/note-folders", { schema: { response: { 200: noteFolderListSchema } } }, async (request) => {
    const rows = await listProfileFolders(pid(request));
    return rows.map(toFolder);
  });

  app.post(
    "/note-folders",
    { schema: { body: createNoteFolderSchema, response: { 201: noteFolderSchema, 404: errorBody } } },
    async (request, reply) => {
      const row = await createFolder(pid(request), request.body);
      if (!row) return reply.status(404).send({ error: "NOT_FOUND" });
      return reply.status(201).send(toFolder(row));
    },
  );

  app.patch(
    "/note-folders/:id",
    {
      schema: {
        params: idParams,
        body: updateNoteFolderSchema,
        response: { 200: noteFolderSchema, 400: errorBody, 404: errorBody },
      },
    },
    async (request, reply) => {
      const result = await updateFolder(pid(request), request.params.id, request.body);
      if (!result.ok) {
        if (result.reason === "CYCLE") return reply.status(400).send({ error: "FOLDER_CYCLE" });
        return reply.status(404).send({ error: "NOT_FOUND" });
      }
      return reply.send(toFolder(result.folder));
    },
  );

  app.delete(
    "/note-folders/:id",
    { schema: { params: idParams, response: { 204: z.null(), 404: errorBody } } },
    async (request, reply) => {
      if (!(await removeFolder(pid(request), request.params.id))) {
        return reply.status(404).send({ error: "NOT_FOUND" });
      }
      return reply.status(204).send(null);
    },
  );
};
