import {
  playerListSchema,
  playerSchema,
  type ControlRequest,
  type Player,
  type QueueAddRequest,
  type SettingsRequest,
} from "@ebook-reader/shared";
import { apiFetch } from "../lib/api-client";

/**
 * The Jukebox routes a person calls (brief 81). Every write answers with the
 * whole `Player`, so the page replaces its copy rather than refetching. The
 * `/jukebox/bot/*` routes are the bot's alone and never called from here.
 */

const json = (body: unknown): RequestInit => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function player(res: Response): Promise<Player> {
  return playerSchema.parse(await res.json());
}

export async function fetchPlayers(): Promise<Player[]> {
  const res = await apiFetch("/jukebox/players");
  return playerListSchema.parse(await res.json());
}

export async function controlPlayer(guildId: string, body: ControlRequest): Promise<Player> {
  return player(await apiFetch(`/jukebox/players/${guildId}/control`, { method: "POST", ...json(body) }));
}

export async function changePlayerSettings(guildId: string, body: SettingsRequest): Promise<Player> {
  return player(await apiFetch(`/jukebox/players/${guildId}/settings`, { method: "PATCH", ...json(body) }));
}

/** A person's entry is attributed to the active profile by the server, so no `addedBy`. */
export async function addToQueue(guildId: string, body: Omit<QueueAddRequest, "addedBy">): Promise<Player> {
  return player(await apiFetch(`/jukebox/players/${guildId}/queue`, { method: "POST", ...json(body) }));
}

export async function removeQueueEntry(guildId: string, entryId: number): Promise<Player> {
  return player(await apiFetch(`/jukebox/players/${guildId}/queue/${entryId}`, { method: "DELETE" }));
}

export async function moveQueueEntry(guildId: string, entryId: number, toIndex: number): Promise<Player> {
  return player(
    await apiFetch(`/jukebox/players/${guildId}/queue/${entryId}/move`, { method: "POST", ...json({ toIndex }) }),
  );
}

export async function clearQueue(guildId: string): Promise<Player> {
  return player(await apiFetch(`/jukebox/players/${guildId}/queue`, { method: "DELETE" }));
}
