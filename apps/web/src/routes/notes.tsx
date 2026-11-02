import { getRouteApi } from "@tanstack/react-router";

import { NotesList } from "../notes/NotesList";
import { NoteEditor } from "../notes/NoteEditor";

const routeApi = getRouteApi("/notes");

/**
 * `/notes`. One route, two views keyed off the `?note=<id>` search
 * param (same pattern as `/read?book=`): the list when absent, the editor when
 * present. Keeps the notes area a single destination in the nav.
 */
export function Notes() {
  const { note } = routeApi.useSearch();
  return note ? <NoteEditor id={note} /> : <NotesList />;
}
