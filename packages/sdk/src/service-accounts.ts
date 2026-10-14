import type {
  CredentialPolicy,
  ProjectRole,
  ServiceAccount,
  WorkloadBinding,
  WorkloadBindingRequest,
} from "@tila/schemas";
import type { TilaClient } from "./client";

export type { WorkloadBinding } from "@tila/schemas";
export function createServiceAccountMethods(
  client: TilaClient,
  projectId: string,
) {
  const base = `/projects/${encodeURIComponent(projectId)}/service-accounts`;
  const accountPath = (id: string) => `${base}/${encodeURIComponent(id)}`;
  return {
    list: () =>
      client.get<{ ok: true; service_accounts: ServiceAccount[] }>(base),
    create: (input: {
      name: string;
      display_name: string;
      role?: ProjectRole;
    }) =>
      client.post<{ ok: true; service_account: ServiceAccount }>(base, input),
    update: (id: string, displayName: string, expectedRevision?: number) =>
      client.patch<{ ok: true; service_account: ServiceAccount }>(
        accountPath(id),
        { display_name: displayName, expected_revision: expectedRevision },
      ),
    revoke: (id: string) => client.delete<{ ok: true }>(accountPath(id)),
    listWorkloadBindings: (id: string) =>
      client.get<{ ok: true; bindings: WorkloadBinding[] }>(
        `${accountPath(id)}/workload-bindings`,
      ),
    createWorkloadBinding: (id: string, input: WorkloadBindingRequest) =>
      client.post<{ ok: true; binding: WorkloadBinding }>(
        `${accountPath(id)}/workload-bindings`,
        input,
      ),
    updateWorkloadBinding: (
      id: string,
      bindingId: string,
      policy: CredentialPolicy,
      expectedRevision?: number,
    ) =>
      client.patch<{ ok: true; binding: WorkloadBinding }>(
        `${accountPath(id)}/workload-bindings/${encodeURIComponent(bindingId)}`,
        { policy, expected_revision: expectedRevision },
      ),
    revokeWorkloadBinding: (id: string, bindingId: string) =>
      client.delete<{ ok: true }>(
        `${accountPath(id)}/workload-bindings/${encodeURIComponent(bindingId)}`,
      ),
  };
}
