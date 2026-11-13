/**
 * Reading Room–styled native `<select>` (design.md "Inputs": minimalist bottom
 * border that turns `primary` on focus). The UA's default closed control never
 * matches the palette — most visibly a white chrome pill floating in the sepia
 * and dark themes — so the closed control is restyled with `appearance-none`
 * plus a `currentColor` chevron while keeping the native element: keyboard,
 * screen-reader, and mobile picker behavior all come for free. The open list
 * follows the `color-scheme` set per theme in globals.css.
 */
export function QuietSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  stacked = false,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  /** `false` (default): inline "Label: [control]". `true`: caps label above
   *  the control (the /discover filter-row treatment). */
  stacked?: boolean;
}) {
  const control = (
    <span className="relative inline-flex items-center">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="quiet-select flex h-9 appearance-none items-center rounded-card border border-outline bg-paper-raised pr-8 pl-3 font-ui text-ui font-medium text-ink transition hover:bg-paper-low focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-[820px]:h-11"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronGlyph className="pointer-events-none absolute right-2.5 h-4 w-4 text-ink-variant" />
    </span>
  );

  if (stacked) {
    return (
      <label className="flex flex-col gap-1.5">
        <span className="font-ui text-ui font-medium text-ink-variant">{label}</span>
        {control}
      </label>
    );
  }

  // Inline: caps label, matching the segmented controls it shares a row with
  // (label-caps is the one label voice on that toolbar line).
  return (
    <label className="flex items-center gap-2 font-ui text-ui font-medium text-ink-variant">
      {label}
      {control}
    </label>
  );
}

function ChevronGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className={className} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
    </svg>
  );
}
