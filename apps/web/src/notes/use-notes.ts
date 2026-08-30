import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NotePage, NoteSummary } from "@ebook-reader/shared";

import { useActiveProfileId } from "../lib/auth";
import {
  createNote,
  createNoteFolder,
  deleteNote,
  deleteNoteFolder,
  fetchNote,
  fetchNoteFolders,
  fetchNotes,
  moveNote,
  updateNote,
  updateNoteFolder,
} from "./notes-api";

/**
 * React Query hooks for notes (brief 26). Mirrors the library hooks' shape:
 * one list query + mutations that invalidate it. The editor uses `useNote`
 * (single) + `useSaveNote` (debounced autosave PATCH).
 */

/**
 * Note query keys carry the active profile (brief 35 step 7). Notes moved from
 * user scope to profile scope (D35 decision 3), so a cached list is one
 * person's notebook and a key without an identity in it would hand it to the
 * next person who switches in. `switchProfile` clears the cache outright; this
 * is the second line of defence for a cache that survives anyway.
 *
 * Unlike the library — which stays shared across profiles, so its mutations
 * invalidate the broad `["library"]` prefix — notes belong to exactly one
 * profile, so these invalidations are scoped to the active one.
 */
const notesKey = (profileId: string | null) => ["notes", profileId] as const;
/** Single-note key. Carries the profile for the same reason the list does: a
 *  note id is unique, but serving a cached body after a switch would show the
 *  previous profile's work while its refetch 404s. */
const noteKey = (profileId: string | null, id: string | undefined) =>
  ["note", profileId, id] as const;

export function useNotesList() {
  const profileId = useActiveProfileId();
  return useQuery({ queryKey: notesKey(profileId), queryFn: fetchNotes });
}

export function useNote(id: string | undefined) {
  const profileId = useActiveProfileId();
  return useQuery({
    queryKey: noteKey(profileId, id),
    queryFn: () => fetchNote(id as string),
    enabled: Boolean(id),
  });
}

export function useCreateNote() {
  const qc = useQueryClient();
  const profileId = useActiveProfileId();
  return useMutation({
    mutationFn: (title?: string) => createNote(title),
    onSuccess: () => void qc.invalidateQueries({ queryKey: notesKey(profileId) }),
  });
}

export function useDeleteNote() {
  const qc = useQueryClient();
  const profileId = useActiveProfileId();
  return useMutation({
    mutationFn: (note: NoteSummary) => deleteNote(note.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: notesKey(profileId) }),
  });
}

/**
 * Save a note's title/pages. Does NOT invalidate the single-note query (the
 * editor is the source of truth for the open note — refetching would clobber
 * in-flight edits); it refreshes the LIST so titles/timestamps stay current.
 */
export function useSaveNote(id: string) {
  const qc = useQueryClient();
  const profileId = useActiveProfileId();
  return useMutation({
    mutationFn: (fields: { title?: string; pages?: NotePage[] }) => updateNote(id, fields),
    onSuccess: () => void qc.invalidateQueries({ queryKey: notesKey(profileId) }),
  });
}

/* -------------------------------------------------------------------------
 * Note folders (brief 50)
 *
 * Their own query key, carrying the active profile for exactly the reason the
 * note keys do: a folder tree belongs to one person, and a cached tree served
 * after a switch would draw the previous profile's shelves around the new
 * profile's notes.
 *
 * Every folder mutation invalidates BOTH keys. That is not belt-and-braces:
 * deleting a folder lifts its notes to the parent, so the note list's
 * `folderId`s change without a single note being edited. A folder mutation
 * that refreshed only the folder list would leave notes drawn under a folder
 * that no longer exists.
 * ---------------------------------------------------------------------- */

const foldersKey = (profileId: string | null) => ["note-folders", profileId] as const;

export function useNoteFolders() {
  const profileId = useActiveProfileId();
  return useQuery({ queryKey: foldersKey(profileId), queryFn: fetchNoteFolders });
}

/** Invalidate the folder tree and the note list together — see the note above. */
function useInvalidateTree() {
  const qc = useQueryClient();
  const profileId = useActiveProfileId();
  return () => {
    void qc.invalidateQueries({ queryKey: foldersKey(profileId) });
    void qc.invalidateQueries({ queryKey: notesKey(profileId) });
  };
}

export function useCreateFolder() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: (vars: { name: string; parentId: string | null }) =>
      createNoteFolder(vars.name, vars.parentId),
    onSuccess: invalidate,
  });
}

/** Rename and/or reparent. `parentId: null` moves the folder to the root. */
export function useUpdateFolder() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: (vars: { id: string; name?: string; parentId?: string | null }) =>
      updateNoteFolder(vars.id, { name: vars.name, parentId: vars.parentId }),
    onSuccess: invalidate,
  });
}

/** Delete a folder. Its notes and subfolders survive, lifted to its parent. */
export function useDeleteFolder() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: (id: string) => deleteNoteFolder(id),
    onSuccess: invalidate,
  });
}

/** File a note into a folder (`null` = the root). */
export function useMoveNote() {
  const invalidate = useInvalidateTree();
  return useMutation({
    mutationFn: (vars: { id: string; folderId: string | null }) =>
      moveNote(vars.id, vars.folderId),
    onSuccess: invalidate,
  });
}
