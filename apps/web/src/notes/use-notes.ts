import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NotePage, NoteSummary } from "@ebook-reader/shared";

import { ApiError } from "../lib/api-client";
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
 * (single) + `useNoteAutosave` (the serialized autosave pipeline).
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

/* -------------------------------------------------------------------------
 * Autosave (brief 56)
 *
 * Every save carries the whole notebook, so the pipeline has three rules:
 *
 * 1. **One save at a time.** Saves run through one promise chain, the way
 *    `LatexEditor`'s `writeQueueRef` chains its writes. While one is in flight
 *    at most one more waits behind it, and the waiting one reads the LATEST
 *    state when it starts, never the state at the moment it was asked for.
 *    Two unsequenced PATCHes could land out of order and an older, smaller
 *    notebook would overwrite a newer one.
 * 2. **Dirty until acknowledged.** Each edit bumps a version; the note is clean
 *    only once the save carrying the current version has answered. A failed
 *    save leaves it dirty, so the next edit, the retry interval or leaving the
 *    page sends it again.
 * 3. **Failures are said out loud** (PRODUCT.md principle 6). `status` is what
 *    the editor chrome shows. `NOTE_TOO_LARGE` is its own state because no
 *    retry fixes it; only an edit that shrinks the note can.
 *
 * The editor is the source of truth for the open note, so a save does NOT
 * invalidate the single-note query (a refetch would clobber edits made while
 * it was in flight). It refreshes the LIST so titles and timestamps stay
 * current.
 * ---------------------------------------------------------------------- */

export type NoteSaveStatus = "saved" | "failing" | "too-large";

export interface NoteDraft {
  title: string;
  pages: NotePage[];
}

/** How often a failing save is retried with no edit to prompt it. */
const RETRY_MS = 10_000;

function isTooLarge(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 413 &&
    (error.body as { error?: unknown } | undefined)?.error === "NOTE_TOO_LARGE"
  );
}

/**
 * The open note's save pipeline. The editor calls `track` on every render with
 * its current draft (a ref write, so a save that starts later reads the latest
 * state), `markDirty` on every edit, and `save` to ask for a save. Every
 * returned function is stable for the editor's lifetime, so an effect can
 * register them once.
 */
export function useNoteAutosave(id: string) {
  const qc = useQueryClient();
  const profileId = useActiveProfileId();
  const [status, setStatus] = useState<NoteSaveStatus>("saved");

  const draftRef = useRef<NoteDraft | null>(null);
  const versionRef = useRef(0);
  const ackedRef = useRef(0);
  /** The chain's tail, with failures swallowed so one failure never jams it. */
  const tailRef = useRef<Promise<void>>(Promise.resolve());
  /** The save waiting behind the one in flight, if any. Joined, not duplicated. */
  const queuedRef = useRef<Promise<void> | null>(null);
  // Everything a save needs from React, read through one ref so `save` never
  // changes identity.
  const ctxRef = useRef({ id, qc, profileId });
  ctxRef.current = { id, qc, profileId };

  const track = useCallback((draft: NoteDraft) => {
    draftRef.current = draft;
  }, []);

  const markDirty = useCallback(() => {
    versionRef.current += 1;
  }, []);

  const isDirty = useCallback(() => versionRef.current !== ackedRef.current, []);

  /**
   * Ask for a save. Resolves once the state current at the time of the call is
   * stored (or was already), and rejects if the save carrying it fails.
   */
  const save = useCallback((): Promise<void> => {
    if (queuedRef.current) return queuedRef.current;
    const run = tailRef.current.then(async () => {
      queuedRef.current = null;
      const draft = draftRef.current;
      const version = versionRef.current;
      if (!draft || version === ackedRef.current) return;
      const { id: noteId, qc: client, profileId: pid } = ctxRef.current;
      try {
        await updateNote(noteId, { title: draft.title.trim() || "Untitled note", pages: draft.pages });
      } catch (error) {
        setStatus(isTooLarge(error) ? "too-large" : "failing");
        throw error;
      }
      ackedRef.current = version;
      setStatus("saved");
      void client.invalidateQueries({ queryKey: notesKey(pid) });
    });
    queuedRef.current = run;
    tailRef.current = run.catch(() => undefined);
    return run;
  }, []);

  // Retry a failing save on a gentle interval as well as on the next edit. A
  // too-large note is not retried here: the same bytes will be refused again.
  useEffect(() => {
    if (status !== "failing") return;
    const timer = setInterval(() => {
      if (versionRef.current !== ackedRef.current) save().catch(() => undefined);
    }, RETRY_MS);
    return () => clearInterval(timer);
  }, [status, save]);

  return { status, track, markDirty, isDirty, save };
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
