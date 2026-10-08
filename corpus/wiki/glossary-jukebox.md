---
summary: Naming authority for the Jukebox, atrium's remote control for the Discord bot's music. Defines jukebox, player, track, playlist, queue, queue entry and the bot account. just-a-bot's glossary repeats these terms and defers to this page.
updated: 2026-10-08
---

# Glossary: Jukebox

The third part of the project's naming authority, split from
[glossary.md](glossary.md) because that page was at the size limit. The rules
are the same. One canonical term per concept, `_Avoid_` lists the synonyms it
displaces, and definitions only. The design was settled in a grilling session
on 2026-10-08. The bot side lives in just-a-bot, whose glossary repeats these
terms and points back here.

**Jukebox**:
The feature that lets the Discord bot play atrium's music. Also the atrium page
that controls it. The page covers every Player.
_Avoid_: Discord page, bot page, radio, remote, DJ

**Player**:
One guild's Jukebox state. It holds the voice channel the bot sits in, the
Track playing, its position, whether it is paused, and what plays next. There
is one Player per Discord guild, keyed by guild ID. The owner's word for it
during the grilling was "bot instance".
_Avoid_: instance, bot instance, session, room, channel (a Player *has* a voice
channel, it is not one)

**Track**:
A Library item of media kind `audio`, as the Jukebox plays it. The Jukebox
plays only Tracks. It has no other music source.
_Avoid_: song (fine in UI copy, not in code or docs), tune, file, mp3, music
item

**Playlist**:
Every Track in the library, in the order a Player walks through it: artist,
album, then track number. It is the music library seen from the Jukebox, not a
separate list, so uploading or deleting on the Jukebox page changes the library
for everyone (D56). All Players share it.
_Avoid_: library (when the walking order is the point), collection, Winamp list

**Queue**:
A Player's short list of Tracks that play before the Playlist continues. "Play
next", "Add to Discord queue" and Discord's `/jukebox play` put Tracks here, and
it is the only list anyone reorders, trims or clears.
_Avoid_: up next, playlist (that is the whole library), backlog

**Queue entry**:
One Track in a Queue, plus who added it: a profile name from atrium, or a
display name from Discord.
_Avoid_: request, item, slot

**Bot account**:
The Ward account the Discord bot signs in as. Its `atrium` grant carries the
role `jukebox`, which atrium enforces as an allowlist of routes (D55). It is a
separate account, not a profile, because a profile is not a security boundary
(D35).
_Avoid_: bot user, bot profile, service account (Ward has no such concept)
