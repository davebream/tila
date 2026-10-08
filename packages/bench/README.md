# @tila/bench

Reproducible multi-session coordination benchmarks for tila. Methodology, tiers, scenarios, the deployed runbook and the published baseline live in [`docs/benchmarks/`](../../docs/benchmarks/README.md).

```bash
pnpm bench -- list
pnpm bench -- --tier inproc --scenario all --participants 8 --duration 30s --warmup 5s --md
pnpm bench -- --help
pnpm bench:report -- --in packages/bench/results --out docs/benchmarks/BASELINE.md
pnpm --filter @tila/bench test     # CI smoke subset (in-process, invariants only)
```

Raw results are written to `results/` (gitignored). Only the rendered `docs/benchmarks/BASELINE.md` is committed.
