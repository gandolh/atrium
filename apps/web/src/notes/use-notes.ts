import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NotePage, NoteSummary } from "@ebook-reader/shared";

import { useActiveProfileId } from "../lib/auth";
import { createNote, deleteNote, fetchNote, fetchNotes, updateNote } from "./notes-api";

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
