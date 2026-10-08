import type { ProjectRole } from "@tila/schemas";

export const PROJECT_ROLES: ProjectRole[] = [
  "viewer",
  "participant",
  "maintainer",
  "owner",
];

interface RoleSelectProps {
  value: ProjectRole;
  onChange: (role: ProjectRole) => void;
  disabled?: boolean;
  "aria-label": string;
  id?: string;
}

export function RoleSelect({
  value,
  onChange,
  disabled,
  id,
  "aria-label": ariaLabel,
}: RoleSelectProps) {
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as ProjectRole)}
      className="h-7 rounded-md border border-input bg-transparent px-2 font-mono text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {PROJECT_ROLES.map((role) => (
        <option key={role} value={role}>
          {role}
        </option>
      ))}
    </select>
  );
}
