import { randomUUID } from "node:crypto";
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
  type Note,
  type NoteFolder,
  type NotePage,
  type NoteSummary,
} from "@ebook-reader/shared";
import {
  deleteNote,
  deleteNoteFolder,
  getNote,
  getNoteFolder,
  insertNote,
  insertNoteFolder,
  listNoteFolders,
  listNotes,
  renameNoteFolder,
  setNoteFolder,
  setNoteFolderParent,
  updateNote,
  wouldCycleNoteFolder,
  type NoteFolderRow,
  type NoteRow,
} from "./db.js";
import { pdfFilename, renderNotePdf } from "./note-pdf.js";

/**
 * Notes CRUD (brief 26). Per-profile since brief 35 (D35, decision 3): every
 * query is scoped by `request.authProfile` (the app-wide guard in auth.ts
 * attaches it, alongside `authUser`, and 401s otherwise, so these routes
 * never need bespoke auth). Page contents live as JSON in the row's `data`
 * column; the wire shape is the shared `Note` / `NoteSummary`.
 */

const BLANK_PAGE: NotePage = { strokes: [], texts: [], template: "blank" };

/** Decode the JSON `data` column to `NotePage[]` (empty on garbage). */
function parsePages(data: string): NotePage[] {
  try {
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? (parsed as NotePage[]) : [];
  } catch {
    return [];
  }
}

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    pages: parsePages(row.data),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSummary(row: NoteRow): NoteSummary {
  return {
    id: row.id,
    title: row.title,
    updatedAt: row.updated_at,
    pageCount: parsePages(row.data).length,
    folderId: row.folder_id,
  };
}

function toFolder(row: NoteFolderRow): NoteFolder {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    createdAt: row.created_at,
  };
}

export function registerNotesRoutes(app: FastifyInstance): void {
  // The guard guarantees an authProfile on every route here.
  const pid = (request: FastifyRequest): string => request.authProfile!.id;

  app.get("/notes", async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.send(noteListSchema.parse(listNotes(pid(request)).map(toSummary)));
  });

  app.post("/notes", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = createNoteSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "INVALID_REQUEST" });
    const now = new Date().toISOString();
    const row: NoteRow = {
      id: randomUUID(),
      profile_id: pid(request),
      title: parsed.data.title?.trim() || "Untitled note",
      data: JSON.stringify([BLANK_PAGE]),
      created_at: now,
      updated_at: now,
      // A new note is born at the root; filing is `PATCH /notes/:id/folder`.
      folder_id: null,
    };
    insertNote(row);
    return reply.status(201).send(noteSchema.parse(toNote(row)));
  });

  app.get("/notes/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const row = getNote(pid(request), id);
    if (!row) return reply.status(404).send({ error: "NOT_FOUND" });
    return reply.send(noteSchema.parse(toNote(row)));
  });

  /**
   * PDF export (brief 49) — all pages, vector, rendered by `note-pdf.ts`.
   *
   * It reads the note through `getNote(pid(request), id)`, exactly like
   * `GET /notes/:id` above: the profile scope is part of the lookup, not a
   * check bolted on after it, so a note on another profile is a 404 here for
   * the same reason it is there. An export route that read by id alone would
   * be a read of someone else's notebook.
   */
  app.get("/notes/:id/export.pdf", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const row = getNote(pid(request), id);
    if (!row) return reply.status(404).send({ error: "NOT_FOUND" });
    // Parse through the shared schema so `template` picks up its default for
    // notes stored before that field existed.
    const note = noteSchema.parse(toNote(row));
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
    const ok = updateNote(
      pid(request),
      id,
      {
        title: parsed.data.title,
        data: parsed.data.pages ? JSON.stringify(parsed.data.pages) : undefined,
      },
      new Date().toISOString(),
    );
    if (!ok) return reply.status(404).send({ error: "NOT_FOUND" });
    // Re-read to return the canonical stored shape (owner-scoped, so it exists).
    return reply.send(noteSchema.parse(toNote(getNote(pid(request), id)!)));
  });

  app.delete("/notes/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    if (!deleteNote(pid(request), id)) return reply.status(404).send({ error: "NOT_FOUND" });
    return reply.status(204).send();
  });

  /**
   * File a note into a folder — `{"folderId": null}` lifts it back to the root.
   *
   * Its own route rather than a field on `PATCH /notes/:id` (brief 50): that
   * route is the editor's autosave, firing many times a minute with the whole
   * page set, and a move must not be something a save can undo by racing it.
   * Both ids are resolved profile-scoped, so either one belonging to somebody
   * else is a 404 and never a cross-profile file.
   */
  app.patch("/notes/:id/folder", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = moveNoteSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "INVALID_REQUEST" });
    const { id } = request.params as { id: string };
    const profileId = pid(request);
    const { folderId } = parsed.data;
    if (folderId !== null && !getNoteFolder(profileId, folderId)) {
      return reply.status(404).send({ error: "NOT_FOUND" });
    }
    if (!setNoteFolder(profileId, id, folderId)) {
      return reply.status(404).send({ error: "NOT_FOUND" });
    }
    return reply.send(noteSchema.parse(toNote(getNote(profileId, id)!)));
  });

  /* -----------------------------------------------------------------------
   * Note folders (brief 50)
   *
   * Mounted at `/note-folders`, NOT `/notes/folders`. Fastify would in fact
   * route the static segment ahead of `/notes/:id`, but a resource whose
   * correctness depends on router priority against a sibling parametric route
   * is a trap for whoever adds the next `/notes/...` path. A separate root
   * makes "folders are not a note" true in the URL space too.
   *
   * Every handler resolves its ids through the profile-scoped `getNoteFolder`,
   * exactly as the note routes above do: a folder on another profile is not
   * found, so the answer is 404 and never 403 — a 403 would confirm the id
   * exists on somebody else's tree.
   * -------------------------------------------------------------------- */

  app.get("/note-folders", async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.send(noteFolderListSchema.parse(listNoteFolders(pid(request)).map(toFolder)));
  });

  app.post("/note-folders", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = createNoteFolderSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "INVALID_REQUEST" });
    const profileId = pid(request);
    const parentId = parsed.data.parentId ?? null;
    if (parentId !== null && !getNoteFolder(profileId, parentId)) {
      return reply.status(404).send({ error: "NOT_FOUND" });
    }
    const row: NoteFolderRow = {
      id: randomUUID(),
      profile_id: profileId,
      parent_id: parentId,
      name: parsed.data.name,
      created_at: new Date().toISOString(),
    };
    insertNoteFolder(row);
    return reply.status(201).send(noteFolderSchema.parse(toFolder(row)));
  });

  /**
   * Rename and/or reparent a folder.
   *
   * The cycle check is the load-bearing part. `parent_id` describes a tree only
   * for as long as nothing points a folder at one of its own descendants; the
   * moment something does, that subtree is detached from the root and every
   * walk over it — including the list render — runs forever. So the server
   * refuses it with a 400 rather than trusting the client not to ask.
   * `parentId: null` means "move to the root" and is always allowed.
   */
  app.patch("/note-folders/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = updateNoteFolderSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "INVALID_REQUEST" });
    const { id } = request.params as { id: string };
    const profileId = pid(request);
    if (!getNoteFolder(profileId, id)) return reply.status(404).send({ error: "NOT_FOUND" });

    const { name, parentId } = parsed.data;
    if (parentId !== undefined && parentId !== null) {
      if (!getNoteFolder(profileId, parentId)) {
        return reply.status(404).send({ error: "NOT_FOUND" });
      }
      if (wouldCycleNoteFolder(profileId, id, parentId)) {
        return reply.status(400).send({ error: "FOLDER_CYCLE" });
      }
    }

    if (name !== undefined) renameNoteFolder(profileId, id, name);
    if (parentId !== undefined) setNoteFolderParent(profileId, id, parentId);
    return reply.send(noteFolderSchema.parse(toFolder(getNoteFolder(profileId, id)!)));
  });

  /**
   * Delete a folder. **Nothing inside it is deleted** — its notes and its child
   * folders are lifted to its own parent first, in one transaction (see
   * `deleteNoteFolder`). A folder is a label; a note is authored work that
   * exists nowhere else, and a mis-clicked delete must not be able to take one.
   */
  app.delete("/note-folders/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    if (!deleteNoteFolder(pid(request), id)) {
      return reply.status(404).send({ error: "NOT_FOUND" });
    }
    return reply.status(204).send();
  });
}
