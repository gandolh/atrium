import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LatexCompileResult, LatexFile, LatexProject } from "@ebook-reader/shared";

import { useActiveProfileId } from "../lib/auth";
import {
  cancelLatexProject,
  compileLatexProject,
  createLatexProject,
  deleteLatexFile,
  deleteLatexProject,
  fetchLatexCompileLog,
  fetchLatexFiles,
  fetchLatexFileText,
  fetchLatexPdf,
  fetchLatexProject,
  fetchLatexProjects,
  publishLatexProject,
  renameLatexFile,
  updateLatexProject,
  writeLatexFile,
} from "./latex-api";

/**
 * React Query hooks for LaTeX projects (brief 38 chunk 7). Mirrors
 * `notes/use-notes.ts`'s shape exactly: one list query + mutations that
 * invalidate it, keys carrying the active profile.
 *
 * Projects are per-profile (brief context, same as notes) — a cached list is
 * one person's drafts, so a key without an identity in it would hand it to
 * the next person who switches in. `switchProfile` clears the cache outright;
 * this is the second line of defence for a cache that survives anyway.
 */
const latexProjectsKey = (profileId: string | null) => ["latex-projects", profileId] as const;
const latexProjectKey = (profileId: string | null, id: string | undefined) =>
  ["latex-project", profileId, id] as const;

export function useLatexProjects() {
  const profileId = useActiveProfileId();
  return useQuery({ queryKey: latexProjectsKey(profileId), queryFn: fetchLatexProjects });
}

/**
 * Whether the **server** says a compile is in flight for this project.
 *
 * The one place `"running"` is read as "a compile is happening", so the
 * polling decision below and the editor's compile/cancel toggle cannot come to
 * different conclusions about it. `undefined` (not loaded yet) is not running —
 * a button must not offer to cancel a compile nobody has confirmed exists.
 */
export function latexCompileRunning(project: LatexProject | undefined): boolean {
  return project?.compileStatus === "running";
}

/**
 * One project, with its `compileStatus`.
 *
 * Polls `GET /latex/:id` at a flat **5s**, but ONLY while the last known status
 * reads `running`; every other status disables the interval outright. Same
 * shape and same reasoning as `useConvertingBook` in `lib/use-library.ts`, at a
 * shorter cadence because a compile is bounded by `LATEX_TIMEOUT_MS` (two
 * minutes) rather than by a conversion's hours — worst case ~24 requests for a
 * compile that runs to the backstop, and typically none at all, since a project
 * nobody is compiling polls zero times forever.
 *
 * **This is what makes the Cancel affordance reachable from anywhere.** The
 * status has to be driven by the fetched row rather than by a client-side "I
 * started this compile" flag, because a reloaded tab, a second tab, and a tab
 * that navigated in from another project have no such flag and are all equally
 * entitled to stop the compile — `busyMessage` on the server tells people to go
 * and cancel it, and an affordance that only exists in the tab that started it
 * would be an instruction they cannot follow. `refetchIntervalInBackground`
 * stays at its default `false`, so a hidden tab polls nothing.
 */
export function useLatexProject(id: string | undefined) {
  const profileId = useActiveProfileId();
  return useQuery({
    queryKey: latexProjectKey(profileId, id),
    queryFn: () => fetchLatexProject(id as string),
    enabled: Boolean(id),
    refetchInterval: (query) => (latexCompileRunning(query.state.data) ? 5_000 : false),
  });
}

export function useCreateLatexProject() {
  const qc = useQueryClient();
  const profileId = useActiveProfileId();
  return useMutation({
    mutationFn: (title: string) => createLatexProject(title),
    onSuccess: () => void qc.invalidateQueries({ queryKey: latexProjectsKey(profileId) }),
  });
}

export function useUpdateLatexProject(id: string) {
  const qc = useQueryClient();
  const profileId = useActiveProfileId();
  return useMutation({
    mutationFn: (fields: { title?: string; entrypoint?: string }) => updateLatexProject(id, fields),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: latexProjectsKey(profileId) });
      // The SINGLE project too (brief 38 chunk 8): the editor reads
      // `entrypoint` off it to mark the main file in the tree, so without this
      // "make this the main file" succeeds on the server and the badge never
      // moves. Safe for a title change as well — the editor seeds its title
      // input once and never re-seeds, so a refetch cannot clobber typing.
      void qc.invalidateQueries({ queryKey: latexProjectKey(profileId, id) });
    },
  });
}

export function useDeleteLatexProject() {
  const qc = useQueryClient();
  const profileId = useActiveProfileId();
  return useMutation({
    mutationFn: (project: LatexProject) => deleteLatexProject(project.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: latexProjectsKey(profileId) }),
  });
}

// --- Files (brief 38 chunk 8) ------------------------------------------------

/**
 * File keys carry the profile for the same reason the project keys above do —
 * a cached `main.tex` is one person's draft. They also carry the project id, so
 * two projects' trees never share an entry.
 */
const latexFilesKey = (profileId: string | null, projectId: string | undefined) =>
  ["latex-files", profileId, projectId] as const;
const latexFileKey = (
  profileId: string | null,
  projectId: string | undefined,
  path: string | null,
) => ["latex-file", profileId, projectId, path] as const;

/** The project's file tree. */
export function useLatexFiles(projectId: string | undefined) {
  const profileId = useActiveProfileId();
  return useQuery({
    queryKey: latexFilesKey(profileId, projectId),
    queryFn: () => fetchLatexFiles(projectId as string),
    enabled: Boolean(projectId),
  });
}

/**
 * One file's text. `staleTime: Infinity` on purpose: the editor is the single
 * writer (decision 7), so once a file is open the local buffer is the truth
 * and a background refetch could only ever clobber it. Switching away and back
 * re-reads from the server, which is the intended refresh.
 */
export function useLatexFileText(projectId: string | undefined, path: string | null) {
  const profileId = useActiveProfileId();
  return useQuery({
    queryKey: latexFileKey(profileId, projectId, path),
    queryFn: () => fetchLatexFileText(projectId as string, path as string),
    enabled: Boolean(projectId) && Boolean(path),
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * Autosave one file (create or overwrite).
 *
 * Does NOT invalidate the open file's text query — the editor owns the buffer,
 * exactly as `useSaveNote` leaves the open note alone. It does, however, write
 * the bytes it just sent INTO that cache (see below). It also does not
 * invalidate the TREE, which fires on every debounce tick while someone types;
 * the response already carries the file's new size and mtime, so the cached row
 * is patched in place instead. A brand-new path (not yet in the tree) does
 * trigger one refetch, since a create really does change the shape of the tree.
 */
export function useWriteLatexFile(projectId: string) {
  const qc = useQueryClient();
  const profileId = useActiveProfileId();
  return useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      writeLatexFile(projectId, path, content),
    onSuccess: (file, { path, content }) => {
      // **A successful write must make the cached text agree with what was
      // written.** Without this the file-text cache kept the PRE-EDIT bytes
      // forever: the query is `staleTime: Infinity` (the editor is the single
      // writer, so a background refetch could only clobber a live buffer) and
      // nothing here invalidated or updated it. Open `main.tex`, type, let the
      // autosave PUT succeed, switch to another file and back inside the 5
      // minute `gcTime`, and `LatexEditor`'s reseed effect — its
      // `draftRef.current?.path === openPath` guard now false — reseeded the
      // buffer from that stale cache. The editor visibly REVERTED to the
      // pre-edit text, and the next keystroke autosaved the stale-based content
      // back over the real one, destroying the saved edit for good.
      //
      // We write the exact `content` we sent rather than re-reading the server:
      // last-write-wins per file is the whole model (decision 7), so what this
      // PUT wrote IS what the server now holds.
      //
      // Both keys, when they differ: `path` is what the caller asked for (and
      // therefore the key `useLatexFileText` is reading under — a diagnostic
      // jump can open a file by a non-canonical path), while `file.path` is the
      // server's canonical answer (and the key the tree, delete and rename all
      // use). Seeding only one of them would leave the other stale, which is
      // this bug again by another route.
      qc.setQueryData<string>(latexFileKey(profileId, projectId, file.path), content);
      if (path !== file.path) {
        qc.setQueryData<string>(latexFileKey(profileId, projectId, path), content);
      }

      const key = latexFilesKey(profileId, projectId);
      const current = qc.getQueryData<LatexFile[]>(key);
      if (!current || !current.some((f) => f.path === file.path)) {
        void qc.invalidateQueries({ queryKey: key });
        return;
      }
      qc.setQueryData<LatexFile[]>(
        key,
        current.map((f) => (f.path === file.path ? file : f)),
      );
    },
  });
}

/** Rename/move a file. Invalidates the tree AND the project (the entrypoint may have moved with it). */
export function useRenameLatexFile(projectId: string) {
  const qc = useQueryClient();
  const profileId = useActiveProfileId();
  return useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) =>
      renameLatexFile(projectId, from, to),
    onSuccess: (file, { from }) => {
      // Carry the already-loaded text across to the new key rather than
      // re-fetching bytes a rename did not change. Read before the remove.
      const fromKey = latexFileKey(profileId, projectId, from);
      const text = qc.getQueryData<string>(fromKey);
      qc.removeQueries({ queryKey: fromKey });
      if (text !== undefined) {
        qc.setQueryData<string>(latexFileKey(profileId, projectId, file.path), text);
      }
      void qc.invalidateQueries({ queryKey: latexFilesKey(profileId, projectId) });
      void qc.invalidateQueries({ queryKey: latexProjectKey(profileId, projectId) });
      void qc.invalidateQueries({ queryKey: latexProjectsKey(profileId) });
    },
  });
}

/** Delete a file. */
export function useDeleteLatexFile(projectId: string) {
  const qc = useQueryClient();
  const profileId = useActiveProfileId();
  return useMutation({
    mutationFn: (path: string) => deleteLatexFile(projectId, path),
    onSuccess: (_void, path) => {
      qc.removeQueries({ queryKey: latexFileKey(profileId, projectId, path) });
      void qc.invalidateQueries({ queryKey: latexFilesKey(profileId, projectId) });
      void qc.invalidateQueries({ queryKey: latexProjectsKey(profileId) });
    },
  });
}

// --- Compile, PDF and log (brief 38 chunk 9) ---------------------------------

const latexLogKey = (profileId: string | null, projectId: string | undefined) =>
  ["latex-log", profileId, projectId] as const;
const latexPdfKey = (profileId: string | null, projectId: string | undefined) =>
  ["latex-pdf", profileId, projectId] as const;

/**
 * The last compile's result — the diagnostics panel's data. `null` means
 * "never compiled," a real renderable state rather than an error (see
 * `fetchLatexCompileLog`). `retry: false` for the same reason chunk 8's file-
 * text query opts out: a project that genuinely has never compiled would
 * otherwise retry into the same 404 a few times before settling.
 */
export function useLatexCompileLog(projectId: string | undefined) {
  const profileId = useActiveProfileId();
  return useQuery({
    queryKey: latexLogKey(profileId, projectId),
    queryFn: () => fetchLatexCompileLog(projectId as string),
    enabled: Boolean(projectId),
    retry: false,
  });
}

/**
 * The compiled PDF, as a `File` ready to hand to `PdfReader` unchanged.
 * Deliberately NOT invalidated by a *failed* compile (`useCompileLatexProject`
 * below) — the cached `File` from the last successful compile stays exactly
 * where it is, which is what keeps the preview pane showing the last good PDF
 * beside a fresh set of errors instead of going blank.
 */
export function useLatexPdf(projectId: string | undefined) {
  const profileId = useActiveProfileId();
  return useQuery({
    queryKey: latexPdfKey(profileId, projectId),
    queryFn: () => fetchLatexPdf(projectId as string),
    enabled: Boolean(projectId),
    retry: false,
    gcTime: 5 * 60_000,
  });
}

/**
 * Compile the project's entrypoint. On success:
 * - the log cache is written DIRECTLY from the response, rather than
 *   invalidated — the compile call already carries exactly the result `/log`
 *   would re-serve, so there is no reason to pay for a second round trip;
 * - the project (and the projects list, for its `compileStatus` badge) is
 *   invalidated so the header and `/latex` both catch up to the new status;
 * - the PDF is refetched only when the compile actually produced one
 *   (`status: "ready"`). A `"failed"` result leaves the PDF query alone on
 *   purpose — see `useLatexPdf`'s doc comment.
 */
export function useCompileLatexProject(projectId: string) {
  const qc = useQueryClient();
  const profileId = useActiveProfileId();
  return useMutation({
    mutationFn: () => compileLatexProject(projectId),
    onSuccess: (result) => {
      qc.setQueryData<LatexCompileResult>(latexLogKey(profileId, projectId), result);
      void qc.invalidateQueries({ queryKey: latexProjectKey(profileId, projectId) });
      void qc.invalidateQueries({ queryKey: latexProjectsKey(profileId) });
      if (result.status === "ready") {
        void qc.invalidateQueries({ queryKey: latexPdfKey(profileId, projectId) });
      }
    },
  });
}

/**
 * Cancel the compile running on this project (brief 44, the last chunk — the
 * cancel affordance in `CompileButton`). On success (`cancelled` true OR
 * false — both are the same "nothing is running here now" outcome, see
 * `cancelLatexProject`), the log, the project and the projects list are all
 * invalidated, exactly the same three `useCompileLatexProject` refreshes on a
 * finished compile — the server flips `compile_status` off `running` on this
 * path too, so the header badge is just as stale as the log.
 *
 * The PDF is deliberately left alone, same reasoning as a failed compile —
 * `out.pdf` is never written on a cancelled run, so the cached `File` from the
 * last SUCCESSFUL compile must keep being served, not refetched into a
 * 404-turned-`null` that would blank the preview pane.
 *
 * Invalidating rather than trusting the in-flight compile POST to have
 * already refreshed the log itself: `cancelAndSettleLatexCompile` and the
 * compile handler's `started.done` can settle in either order (both routes
 * wait on the same underlying job unwind), so this is the belt to
 * `useCompileLatexProject`'s suspenders rather than a duplicate of it.
 */
export function useCancelLatexProject(projectId: string) {
  const qc = useQueryClient();
  const profileId = useActiveProfileId();
  return useMutation({
    mutationFn: () => cancelLatexProject(projectId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: latexLogKey(profileId, projectId) });
      void qc.invalidateQueries({ queryKey: latexProjectKey(profileId, projectId) });
      void qc.invalidateQueries({ queryKey: latexProjectsKey(profileId) });
    },
  });
}

// --- Publish (brief 38 chunk 10) ---------------------------------------------

/**
 * Publish the project (decision 8: one library entry, many versions). On
 * success, invalidates the SINGLE project (its `publishedBookId` moved from
 * `null` to a real id on a first publish, and `compileStatus` may have too —
 * the route compiles first) and the projects list, exactly as
 * `useUpdateLatexProject`/`useCompileLatexProject` already do for their own
 * project-shaped changes.
 *
 * Also invalidates the broad `["library"]` prefix — same reasoning as
 * `useUploadBook`/`useDeleteBook` (`lib/use-library.ts`): a publish changes
 * the shared library (a new card, or a new version on an existing one) for
 * every profile, not just this one, so the gallery must catch up too, not
 * only the editor.
 */
export function usePublishLatexProject(projectId: string) {
  const qc = useQueryClient();
  const profileId = useActiveProfileId();
  return useMutation({
    mutationFn: () => publishLatexProject(projectId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: latexProjectKey(profileId, projectId) });
      void qc.invalidateQueries({ queryKey: latexProjectsKey(profileId) });
      void qc.invalidateQueries({ queryKey: ["library"] });
    },
  });
}
