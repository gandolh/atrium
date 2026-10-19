/**
 * Embed an archify artifact.
 *
 * archify delivers a COMPLETE HTML document — its own <head>, styles, and the
 * viewer runtime that provides pan/zoom, search, relationship tracing and the
 * guided views. It is not a fragment, so it goes in an iframe rather than being
 * inlined: inlining would mean two documents' styles and two viewer runtimes
 * fighting over one page.
 *
 * The frame is given a fixed height rather than being auto-sized: the viewer
 * adapts its reading width to the viewport it is handed, and a height negotiated
 * by script would fight that; a stated height also means the page does not
 * reflow when the diagram finishes loading.
 *
 * `useBaseUrl` prefixes the site's baseUrl, so this keeps working under the
 * `/<project>/docs/` sub-path deploy and at the root during `npm run serve`.
 *
 * Styling hooks (`.doc-diagram*`) are defined per project in src/css/custom.css.
 */
import useBaseUrl from '@docusaurus/useBaseUrl'

interface Props {
  /** File stem under static/diagrams/, e.g. "architecture". */
  name: string
  /** Accessible title for the frame. */
  title: string
  /** Prose below the frame. Say what to look at, not what it is. */
  caption?: string
  /** Frame height in px. */
  height?: number
}

export default function Diagram({ name, title, caption, height = 760 }: Props) {
  const src = useBaseUrl(`/diagrams/${name}.html`)
  return (
    <figure className="doc-diagram">
      <iframe className="doc-diagram__frame" src={src} title={title} height={height} loading="lazy" />
      {caption && (
        <figcaption className="doc-diagram__caption">
          {caption} — <a href={src} target="_blank" rel="noopener">open full screen</a>, where search,
          tracing and the guided views are usable.
        </figcaption>
      )}
    </figure>
  )
}
