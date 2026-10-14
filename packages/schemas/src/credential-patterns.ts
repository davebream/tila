const CREDENTIAL_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "a tila API token", pattern: /tila_d1_[0-9a-f]{72}/ },
  { label: "a tila session token", pattern: /tila_u_[A-Za-z0-9._~-]{16,}/ },
  {
    label: "a GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/,
  },
  {
    label: "a private key",
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/,
  },
  { label: "an AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: "a Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { label: "an API key", pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/ },
  {
    label: "a JSON Web Token",
    pattern:
      /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
];

/** Shared lightweight value guard; labels and diagnostics never include values. */
export function credentialValueLabel(value: string): string | undefined {
  return CREDENTIAL_PATTERNS.find((entry) => entry.pattern.test(value))?.label;
}
export function containsCredentialValue(value: unknown): boolean {
  if (typeof value === "string")
    return credentialValueLabel(value) !== undefined;
  if (Array.isArray(value)) return value.some(containsCredentialValue);
  if (value && typeof value === "object")
    return Object.entries(value).some(
      ([key, item]) =>
        credentialValueLabel(key) !== undefined ||
        containsCredentialValue(item),
    );
  return false;
}
