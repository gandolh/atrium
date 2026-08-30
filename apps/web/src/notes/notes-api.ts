import {
  noteListSchema,
  noteSchema,
  type Note,
  type NotePage,
  type NoteSummary,
} from "@ebook-reader/shared";
import { apiFetch } from "../lib/api-client";

/**
 * Notes API calls (brief 26). Thin wrappers over the Fastify `/notes` routes;
 * responses validate against the shared Zod contract so the client can't drift
 * (D11). Auth rides on `apiFetch` (bearer token).
 */

export async function fetchNotes(): Promise<NoteSummary[]> {
  const res = await apiFetch("/notes");
  return noteListSchema.parse(await res.json());
}

export async function fetchNote(id: string): Promise<Note> {
  const res = await apiFetch(`/notes/${id}`);
  return noteSchema.parse(await res.json());
}

export async function createNote(title?: string): Promise<Note> {
  const res = await apiFetch("/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(title ? { title } : {}),
  });
  return noteSchema.parse(await res.json());
}

export async function updateNote(
  id: string,
  fields: { title?: string; pages?: NotePage[] },
): Promise<Note> {
  const res = await apiFetch(`/notes/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  return noteSchema.parse(await res.json());
}

export async function deleteNote(id: string): Promise<void> {
  await apiFetch(`/notes/${id}`, { method: "DELETE" });
}

/**
 * Fetch the whole note as a PDF (brief 49). The server renders it (`apps/api`
 * has pdf-lib; the browser deliberately carries no PDF writer), so this is
 * only a transfer — but it still has to go through `apiFetch` rather than a
 * plain link or `window.open`, because auth here is a bearer token and a
 * navigation cannot carry one.
 */
export async function fetchNotePdf(id: string): Promise<Blob> {
  const res = await apiFetch(`/notes/${id}/export.pdf`);
  return res.blob();
}
