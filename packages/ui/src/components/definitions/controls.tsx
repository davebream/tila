import type { ReactNode } from "react";

/** A labelled native checkbox; keyboard and screen-reader behaviour for free. */
export function CheckboxField({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-0.5 size-4 accent-signal-blue"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        {hint && (
          <span className="block text-xs text-muted-foreground">{hint}</span>
        )}
      </span>
    </label>
  );
}

/** Choose any subset of `options`, keeping the order of `options`. */
export function CheckboxGroup({
  legend,
  hint,
  options,
  value,
  disabled,
  error,
  onChange,
}: {
  legend: ReactNode;
  hint?: ReactNode;
  options: readonly string[];
  value: readonly string[];
  disabled?: boolean;
  error?: string;
  onChange: (value: string[]) => void;
}) {
  return (
    <fieldset className="space-y-1.5" aria-invalid={error ? true : undefined}>
      <legend className="tila-label">{legend}</legend>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {options.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing to choose yet.</p>
      ) : (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {options.map((option) => (
            <CheckboxField
              key={option}
              label={<span className="font-mono">{option}</span>}
              checked={value.includes(option)}
              disabled={disabled}
              onChange={(checked) =>
                onChange(
                  options.filter((o) =>
                    o === option ? checked : value.includes(o),
                  ),
                )
              }
            />
          ))}
        </div>
      )}
      {error && <p className="text-xs text-status-red">{error}</p>}
    </fieldset>
  );
}

/** Section heading inside a definition editor. */
export function EditorSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}
