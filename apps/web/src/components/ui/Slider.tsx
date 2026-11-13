import { Slider as BaseSlider } from "@base-ui/react/slider";

import { cn } from "../../lib/cn";

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onValueChange: (value: number) => void;
  /** The readout beside the label. */
  format?: (value: number) => string;
  className?: string;
}

/** A labelled value slider with a readout. A scrubbing surface with a hover tooltip is not this: see conventions.json. */
export function Slider({ label, value, min, max, step = 1, onValueChange, format, className }: SliderProps) {
  return (
    <BaseSlider.Root
      value={value}
      min={min}
      max={max}
      step={step}
      onValueChange={(next) => {
        if (typeof next === "number") onValueChange(next);
      }}
    >
      <div className={cn("mb-1 flex items-center justify-between text-xs text-reader-fg/80", className)}>
        <BaseSlider.Label>{label}</BaseSlider.Label>
        <span className="tabular-nums">{format ? format(value) : value}</span>
      </div>
      <BaseSlider.Control className="flex h-5 w-full items-center">
        <BaseSlider.Track className="h-1 w-full rounded-full bg-reader-border">
          <BaseSlider.Indicator className="rounded-full bg-reader-accent" />
          <BaseSlider.Thumb className="size-4 rounded-full border border-reader-border bg-reader-bg shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-reader-accent" />
        </BaseSlider.Track>
      </BaseSlider.Control>
    </BaseSlider.Root>
  );
}
