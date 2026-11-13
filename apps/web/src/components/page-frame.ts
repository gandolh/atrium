/**
 * The frame every page sets its content in, under the shell's band or top bar: a 1152 px cap, 32 px of side padding
 * at 1280 and 16 px on a phone, and the page's own rhythm. `flex-1` so the frame fills the shell's column.
 */
export const PAGE_FRAME =
  "mx-auto flex w-full max-w-(--container-page) flex-1 flex-col px-4 pt-5 pb-6 min-[821px]:px-8 min-[821px]:pt-6 min-[821px]:pb-12";

/** The page title: Newsreader at 40 on the ground, 32 on a phone. */
export const PAGE_TITLE = "font-display text-display-phone text-balance text-ink min-[821px]:text-display";
