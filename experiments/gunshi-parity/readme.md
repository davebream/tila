# Signal parser parity trial

Decision: retain production Citty. Gunshi 0.37.3 does not pass the global-option
ordering or four-shell completion adoption gates. Green negative tests record
blockers; they do not authorize migration.

This directory is outside the pnpm workspace. The deterministic signal fixture
backs both adapters, which call the production parser-independent `signalHandlers`.
No credentials or live backend are used. The Incur experiment remains unchanged.

```sh
npm ci --ignore-scripts
bun test
bun build --compile citty.ts --outfile dist/citty
bun build --compile gunshi.ts --outfile dist/gunshi
./dist/citty group get team --json
./dist/gunshi group get team --json
```

Tests cover all eight operations, nested commands, JSON parity, required inputs,
stale fences, explicit project context and participant isolation. Gunshi fails
`--project project-one group list --json`; flags after the command work. Native
lifecycle resolution is covered in production tests, not separately implemented
in this trial.

Results, startup/size measurements and migration gates are in
[decision 25](../../docs/01-DECISIONS.md#25-cli-invocation-contract-and-parser-evaluation-178).
Gunshi's official completion plugin covers bash/zsh/fish; PowerShell parity is
unproven. Production completion uses `@bomb.sh/tab/citty`.
