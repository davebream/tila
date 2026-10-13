import { cn } from "@/lib/utils";
import {
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
} from "react";

export const controlClass =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-status-red";

interface FieldShellProps {
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  error?: string;
  children: (ids: { id: string; describedBy?: string }) => ReactNode;
}

/** Label, control, hint and error wired together for screen readers. */
export function FieldShell({
  label,
  required,
  hint,
  error,
  children,
}: FieldShellProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") ||
    undefined;
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
        {required && (
          <span className="text-status-red" aria-hidden="true">
            {" "}
            *
          </span>
        )}
        {required && <span className="sr-only"> (required)</span>}
      </label>
      {children({ id, describedBy })}
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-status-red">
          {error}
        </p>
      )}
    </div>
  );
}

type Shared = {
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  error?: string;
};

export function TextField({
  label,
  required,
  hint,
  error,
  className,
  ...props
}: Shared & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <FieldShell label={label} required={required} hint={hint} error={error}>
      {({ id, describedBy }) => (
        <input
          id={id}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          aria-required={required || undefined}
          className={cn(controlClass, className)}
          {...props}
        />
      )}
    </FieldShell>
  );
}

export function TextAreaField({
  label,
  required,
  hint,
  error,
  className,
  ...props
}: Shared & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <FieldShell label={label} required={required} hint={hint} error={error}>
      {({ id, describedBy }) => (
        <textarea
          id={id}
          rows={4}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          aria-required={required || undefined}
          className={cn(controlClass, "min-h-20 font-sans", className)}
          {...props}
        />
      )}
    </FieldShell>
  );
}

export function SelectField({
  label,
  required,
  hint,
  error,
  options,
  placeholder,
  className,
  ...props
}: Shared &
  SelectHTMLAttributes<HTMLSelectElement> & {
    options: Array<{ value: string; label?: string }>;
    /** Shown as an empty first option; omit to force a choice. */
    placeholder?: string;
  }) {
  return (
    <FieldShell label={label} required={required} hint={hint} error={error}>
      {({ id, describedBy }) => (
        <select
          id={id}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          aria-required={required || undefined}
          className={cn(controlClass, className)}
          {...props}
        >
          {placeholder !== undefined && <option value="">{placeholder}</option>}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label ?? option.value}
            </option>
          ))}
        </select>
      )}
    </FieldShell>
  );
}

/** A small inline alert for form-level failures and notices. */
export function FormNotice({
  tone = "error",
  children,
}: {
  tone?: "error" | "info" | "warning";
  children: ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        tone === "error" && "border-status-red/40 text-status-red",
        tone === "warning" && "border-status-amber/40 text-foreground",
        tone === "info" && "border-border text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}
