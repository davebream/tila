import { Badge } from "@/components/ui/badge";
import type { MembershipRepo } from "@/lib/api";
import { formatDateTime } from "@/lib/time";
import type {
  ProjectMembership,
  ProjectMembershipMode,
  WhoamiResponse,
} from "@tila/schemas";

interface MirroredAccessPanelProps {
  mode: ProjectMembershipMode | undefined;
  repos: MembershipRepo[];
  me: WhoamiResponse | undefined;
  ownMembership: ProjectMembership | undefined;
}

function modeSummary(mode: ProjectMembershipMode | undefined): string {
  switch (mode) {
    case "explicit":
      return "Mirroring is off. Only the explicit members listed above have access.";
    case "github-mirrored":
      return "GitHub collaborators on the enabled repositories below receive a mirrored role. Explicit rows are honored only for owner.";
    case "hybrid":
      return "Explicit members and GitHub collaborators on the enabled repositories below both have access; the stronger role wins.";
    case "service-only":
      return "Only service principals with explicit membership have access. Humans cannot sign in to this project.";
    default:
      return "";
  }
}

/**
 * Explains where effective roles come from. Mirrored members are evaluated
 * per request from GitHub permissions and are not materialized, so they
 * cannot be enumerated here; the panel shows the policy and the caller's own
 * derivation instead.
 */
export function MirroredAccessPanel({
  mode,
  repos,
  me,
  ownMembership,
}: MirroredAccessPanelProps) {
  const showRepos = mode === "github-mirrored" || mode === "hybrid";
  const sources = me?.membership_sources ?? [];
  const mirroredRepo = repos.find(
    (r) => r.github_repo_id === me?.mirrored_repo_id,
  );

  return (
    <section
      aria-labelledby="mirrored-access-heading"
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <h3 id="mirrored-access-heading" className="tila-label">
        Access sources
      </h3>
      <p className="text-sm text-muted-foreground">{modeSummary(mode)}</p>

      {showRepos && (
        <div className="space-y-2">
          {repos.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No repositories are linked to this project, so nothing is
              mirrored.
            </p>
          ) : (
            <table className="w-full text-xs" aria-label="Linked repositories">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-3 font-normal">Repository</th>
                  <th className="py-1 pr-3 font-normal">Mirroring</th>
                  <th className="py-1 font-normal">Role cap</th>
                </tr>
              </thead>
              <tbody>
                {repos.map((r) => (
                  <tr key={`${r.github_host}:${r.github_repo_id}`}>
                    <td className="py-1 pr-3 font-mono text-fg-strong">
                      {r.owner}/{r.repo}
                    </td>
                    <td className="py-1 pr-3">
                      <Badge variant={r.membership_enabled ? "green" : "gray"}>
                        {r.membership_enabled ? "on" : "off"}
                      </Badge>
                    </td>
                    <td className="py-1 font-mono">{r.membership_role_cap}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-xs text-muted-foreground">
            Collaborators get viewer, participant or maintainer according to
            their repository permission, capped per repository. GitHub never
            grants owner. Mirrored members are evaluated on each request and are
            not listed.
          </p>
        </div>
      )}

      {me?.role && (
        <div className="space-y-1 border-t border-border pt-3">
          <p className="tila-label">Your access</p>
          <p className="font-mono text-xs text-fg-strong">
            effective role: {me.role}
          </p>
          <ul className="space-y-0.5 font-mono text-xs text-muted-foreground">
            {sources.includes("explicit") && (
              <li>
                explicit {me.explicit_role ?? ownMembership?.role ?? me.role}
                {ownMembership
                  ? ` granted by ${ownMembership.granted_by} on ${formatDateTime(ownMembership.granted_at)}`
                  : ""}
              </li>
            )}
            {sources.includes("github-mirrored") && (
              <li>
                mirrored from{" "}
                {mirroredRepo
                  ? `${mirroredRepo.owner}/${mirroredRepo.repo}`
                  : `repo #${me.mirrored_repo_id ?? "?"}`}
                {mirroredRepo
                  ? ` capped at ${mirroredRepo.membership_role_cap}`
                  : ""}
              </li>
            )}
            {sources.includes("bootstrap") && <li>bootstrap project token</li>}
            {sources.length > 1 && (
              <li>effective role is the stronger of the sources</li>
            )}
          </ul>
        </div>
      )}
    </section>
  );
}
