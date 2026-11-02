import { Slider } from "@base-ui/react/slider";

/**
 * Reusable labelled slider built on Base UI's Slider (wiki/reader.md
 * "Slider (font size/zoom)"). Controlled single-value only. Shared so PDF
 * (zoom) and EPUB (font size / line-spacing / margins) use
 * the same styled control.
 */
export function SliderControl({
  label,
  value,
  min,
  max,
  step = 1,
  onValueChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onValueChange: (value: number) => void;
  /** Optional formatter for the displayed value (e.g. `v => \`${v}%\``). */
  format?: (value: number) => string;
}) {
  return (
    <Slider.Root
      value={value}
      min={min}
      max={max}
      step={step}
      onValueChange={(next) => {
        // Single-value slider → `next` is a number.
        if (typeof next === "number") onValueChange(next);
      }}
    >
      <div className="mb-1 flex items-center justify-between text-xs text-reader-fg/70">
        <Slider.Label>{label}</Slider.Label>
        <span className="tabular-nums">{format ? format(value) : value}</span>
      </div>
      <Slider.Control className="flex h-5 w-full items-center">
        <Slider.Track className="h-1 w-full rounded-full bg-reader-border">
          <Slider.Indicator className="rounded-full bg-reader-accent" />
          <Slider.Thumb className="size-4 rounded-full border border-reader-border bg-reader-bg shadow outline-none focus-visible:ring-2 focus-visible:ring-reader-accent" />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  );
}
