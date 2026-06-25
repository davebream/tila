-- WI-B2: generic OIDC exchange route + _oidc_principals (issue #125, epic #122)
-- Adds nullable OIDC issuer and audience columns to _projects.
-- A project without OIDC configured has both NULL; the exchange route returns
-- oidc-not-configured when either column is NULL/empty.
ALTER TABLE _projects ADD COLUMN oidc_issuer TEXT;
ALTER TABLE _projects ADD COLUMN oidc_audience TEXT;
