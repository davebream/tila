import {
  SelectField,
  TextAreaField,
  TextField,
} from "@/components/ui/form-fields";
import { type RawFields, isListType } from "@/lib/field-values";
import type { CatalogField } from "@tila/schemas";

interface SchemaFormProps {
  fields: CatalogField[];
  values: RawFields;
  errors?: Record<string, string>;
  onChange: (name: string, value: string) => void;
  disabled?: boolean;
  /** Declared fields that are rendered elsewhere or must not be edited here. */
  hidden?: Set<string>;
  /** Field names to label as the title/summary/description. */
  roles?: Record<string, string>;
}

/**
 * One control per declared field, in declaration order. The control follows
 * the declared type; the server still validates every write.
 */
export function SchemaForm({
  fields,
  values,
  errors = {},
  onChange,
  disabled,
  hidden,
  roles = {},
}: SchemaFormProps) {
  const visible = fields.filter((field) => !hidden?.has(field.name));
  if (visible.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        This type declares no editable fields.
      </p>
    );
  return (
    <div className="grid gap-4">
      {visible.map((field) => {
        const label = (
          <>
            <span className="font-mono">{field.name}</span>
            {roles[field.name] && roles[field.name] !== field.name && (
              <span className="text-muted-foreground">
                {" "}
                · {roles[field.name]}
              </span>
            )}
          </>
        );
        const common = {
          label,
          required: field.required,
          error: errors[field.name],
          disabled,
          name: field.name,
          value: values[field.name] ?? "",
        };
        if (field.values?.length)
          return (
            <SelectField
              key={field.name}
              {...common}
              options={field.values.map((value) => ({ value }))}
              placeholder={field.required ? "Choose…" : "None"}
              onChange={(e) => onChange(field.name, e.target.value)}
            />
          );
        if (field.type === "boolean")
          return (
            <SelectField
              key={field.name}
              {...common}
              options={[
                { value: "true", label: "Yes" },
                { value: "false", label: "No" },
              ]}
              placeholder={field.required ? "Choose…" : "Not set"}
              onChange={(e) => onChange(field.name, e.target.value)}
            />
          );
        if (
          field.type === "text" ||
          field.type === "json" ||
          isListType(field.type)
        )
          return (
            <TextAreaField
              key={field.name}
              {...common}
              hint={
                isListType(field.type)
                  ? "One item per line."
                  : field.type === "json"
                    ? "JSON value."
                    : undefined
              }
              className={field.type === "json" ? "font-mono" : undefined}
              onChange={(e) => onChange(field.name, e.target.value)}
            />
          );
        return (
          <TextField
            key={field.name}
            {...common}
            type={field.type === "number" ? "number" : "text"}
            inputMode={field.type === "number" ? "decimal" : undefined}
            onChange={(e) => onChange(field.name, e.target.value)}
          />
        );
      })}
    </div>
  );
}

/** Label each presentation slot so users know which field becomes the title. */
export function presentationRoles(presentation?: {
  title?: string;
  summary?: string;
  description?: string;
}): Record<string, string> {
  const roles: Record<string, string> = {};
  if (presentation?.title) roles[presentation.title] = "title";
  if (presentation?.summary) roles[presentation.summary] ??= "summary";
  if (presentation?.description)
    roles[presentation.description] ??= "description";
  return roles;
}
