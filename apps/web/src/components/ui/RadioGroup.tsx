import { Radio } from "@base-ui/react/radio";
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group";
import type { ComponentProps, ReactNode } from "react";

type WithClass<P> = Omit<P, "className"> & { className?: string };

export interface RadioGroupProps<Value extends string> {
  /** Names the group for a screen reader. */
  label: string;
  value: Value;
  onValueChange: (value: Value) => void;
  className?: string;
  children: ReactNode;
}

/**
 * One choice from a few, where the choice only sets state on this screen and nothing is written to the server: a
 * tool, a thickness, a colour in a form. Tab enters the group and the arrow keys move AND choose (base-ui rule 16).
 * A picker that saves on each choice is a ToggleGroup instead.
 */
export function RadioGroup<Value extends string>({
  label,
  value,
  onValueChange,
  className,
  children,
}: RadioGroupProps<Value>) {
  return (
    <BaseRadioGroup<Value> aria-label={label} value={value} onValueChange={onValueChange} className={className}>
      {children}
    </BaseRadioGroup>
  );
}

export interface RadioItemProps extends WithClass<Omit<ComponentProps<typeof Radio.Root>, "children">> {
  value: string;
  children?: ReactNode;
}

/** One option of a RadioGroup. The look is the caller's `className`, state through `data-checked:`. */
export function RadioItem({ className, children, ...props }: RadioItemProps) {
  return (
    <Radio.Root {...props} className={className}>
      {children}
    </Radio.Root>
  );
}
