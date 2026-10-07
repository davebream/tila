/** Legacy auth fixtures have no service accounts or scoped workload bindings. */
export function credentialMockExports() {
  return {
    SCOPED_TOKEN_MARKER: "scoped-v1",
    CredentialConflict: class extends Error {},
    CredentialDenied: class extends Error {},
    CredentialStore: class {
      async find() {
        return undefined;
      }
      async findBinding() {
        return undefined;
      }
      async list() {
        return [];
      }
      async revokeProjectCredentials() {}
      async resolve() {
        return null;
      }
    },
    RepoAllowlistStore: class {
      async getAccessPolicy() {
        return { status: "not-found" };
      }
    },
    ProjectMembershipStore: class {
      async revokeProjectCredentials() {}
      async resolve() {
        return null;
      }
    },
  };
}
