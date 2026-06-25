-- Per-project generic OIDC configuration (WI-B2, issue #125, epic #122).
-- A project that has not configured generic (non-GitHub) OIDC exchange has
-- both columns NULL; the /api/auth/oidc/exchange route denies (oidc-not-
-- configured) unless both are set. issuer is the only accepted upstream OIDC
-- issuer; audience is the relying-party value the token's `aud` must match.
-- Both nullable, no default (cf. _project_repos.oidc_permission idiom, 0007).
ALTER TABLE _projects ADD COLUMN oidc_issuer TEXT;
ALTER TABLE _projects ADD COLUMN oidc_audience TEXT;
