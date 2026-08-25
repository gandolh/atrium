import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createNoteSchema,
  noteListSchema,
  noteSchema,
  updateNoteSchema,
  type Note,
  type NotePage,
  type NoteSummary,
} from "@ebook-reader/shared";
import {
  deleteNote,
  getNote,
  insertNote,
  listNotes,
  updateNote,
  type NoteRow,
} from "./db.js";

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
}
