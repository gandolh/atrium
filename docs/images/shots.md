# README images

How each image was made, so the next refresh is a re-run. Re-take an image when the screen it shows changes.

| File | Shows | How to reach that state | Viewport | Data | Taken |
|---|---|---|---|---|---|
| hero.webp | Library home with the Continue card and covers | sign in, pick the profile, open a book once so Continue fills, return home | 1440×900 @2x | scratch library below | 2026-10-09 |
| reader-desktop.webp | EPUB reader on Chapter I of Pride and Prejudice, bar showing | open the book, Contents, "Chapter I.", next page, move the mouse to the bottom | 1440×900 @2x | same | 2026-10-09 |
| reader-flow.gif | Open from Continue, three page turns, theme Light → Sepia → Dark | nine screenshots of those steps, stitched (see below) | 1280×800, scaled to 960 | same | 2026-10-09 |
| latex-editor.webp | LaTeX editor with a compiled made-up document | LaTeX, New project, paste the source below, title "Sundial notes", Compile, zoom the preview to 120% | 1440×900 @2x | made-up document | 2026-10-09 |
| library-phone.webp | Library home on a phone | same state as the hero | iPhone 14 emulation | same | 2026-10-09 |
| reader-phone.webp | Reader on a phone, Chapter I | same as reader-desktop | iPhone 14 emulation | same | 2026-10-09 |

## Demo data

The owner's real library never appears. The screenshots use a throwaway library of public-domain books:

1. Download Project Gutenberg EPUBs (`https://www.gutenberg.org/ebooks/<id>.epub3.images`) into a scratch folder. These were used: 1342 Pride and Prejudice, 84 Frankenstein, 2701 Moby-Dick, 11 Alice's Adventures in Wonderland, 1661 The Adventures of Sherlock Holmes, 345 Dracula, 1260 Jane Eyre, 768 Wuthering Heights, 35 The Time Machine, 174 The Picture of Dorian Gray, 98 A Tale of Two Cities, 1400 Great Expectations, 16 Peter Pan, 2554 Crime and Punishment. Leave out any book whose cover credits a living person; Kafka's Metamorphosis (5200) was removed for that reason.
2. Start the dev servers on scratch storage roots, as in [getting-started.md](../getting-started.md#run-against-a-scratch-library). Check the `API ready` log line: all five roots must be under the scratch folder.
3. Sign in with a test account (never the owner's) and keep the profile called "Default". Upload the EPUBs with the library's Upload files button.
4. Reader settings must be Light, Newsreader, 18px when you finish; the GIF changes the theme.

The LaTeX document is made up:

```latex
\documentclass{article}
\title{The Sundial in the Courtyard}
\begin{document}
\maketitle

\section{Why the shadow moves}
A sundial reads the sun's hour angle $h$, which grows by $15^\circ$ every hour. On a horizontal dial at latitude $\varphi$, the shadow for hour angle $h$ falls at an angle $\theta$ from the noon line, where
\begin{equation}
\tan\theta = \sin\varphi \, \tan h .
\end{equation}

\section{The hour lines at $45^\circ$ north}
\begin{tabular}{lr}
Hour & Angle from noon \\
\hline
9 a.m. & $35.3^\circ$ \\
10 a.m. & $22.2^\circ$ \\
11 a.m. & $10.7^\circ$ \\
\end{tabular}

\begin{itemize}
  \item The gnomon points at the celestial pole, so its edge rises at the latitude angle.
  \item Sun time and clock time drift apart by up to a quarter of an hour over the year.
\end{itemize}
\end{document}
```

## Capture

Screenshots: `agent-browser --session atrium set viewport 1440 900 2` (or `set device "iPhone 14"`), then `screenshot <absolute path>.png`, then `ffmpeg -i shot.png -c:v libwebp -quality 82 shot.webp`.

The GIF is stitched from screenshots, not recorded. `agent-browser record start` opens a fresh browser context, which drops the chosen profile and the cached book, so the recording showed the profile picker and a download bar. Take one screenshot per step at 1280×800, list them with a hold time each in an ffmpeg concat file (`file '01.png'` / `duration 1.8`, and so on), then:

```bash
ffmpeg -f concat -safe 0 -i list.txt \
  -vf "scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" \
  -vsync vfr -loop 0 reader-flow.gif
```

Check every frame before committing: `ffmpeg -i reader-flow.gif -vsync 0 frame%02d.png`.
