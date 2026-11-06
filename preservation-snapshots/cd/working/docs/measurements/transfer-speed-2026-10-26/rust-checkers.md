# Rust TypeScript checker comparison

The project's existing `npm run typecheck` invokes TypeScript 7.0.2. `tsconfig.json` checks `worker/**/*.ts` with `noEmit: true`. Vite builds the browser application separately. Replacing this checker cannot make file transfers faster because this command emits no application code.

Two Rust implementations were tested without changing project dependencies:

| Checker | Installed version | Median, 9 samples | Range | Speed relative to existing |
| --- | --- | ---: | ---: | ---: |
| TypeScript | 7.0.2 | 80.86 ms | 76.05–95.44 ms | 1.00x |
| Theo's `tsc-rs` | 0.8.0, compiler 7.1.0-dev | 35.71 ms | 32.52–44.66 ms | 2.26x |
| Oxc/Cloudflare `tsrs` | 0.18.0-ts7.1.0-dev.20260929 | 65.08 ms | 54.96–78.40 ms | 1.24x |

The measurements include process startup through each package's executable, run one warmup per checker, rotate checker order across nine rounds, and verify that every actual-project check exits successfully without diagnostics. An isolated invalid TypeScript fixture checks that every compiler rejects the same assignment errors with TS2322 and TS2741. This small fixture does not prove general compiler equivalence. The Rust tools target newer upstream TypeScript revisions, so this is a comparison of available tools rather than equivalent compiler versions.

Keep the existing dependency for this transfer-speed task. The largest observed saving is about 45 ms per developer type check. There is no measured runtime benefit, and compiler compatibility across the project's future changes has not been established. No lockfile or package changes were made.

## Reproduce

Install into a temporary directory outside the repository, then run from the repository root:

```sh
checker_dir=$(mktemp -d /tmp/cd-rust-checkers-XXXXXX)
npm install --prefix "$checker_dir" --no-audit --no-fund tsc-rs@0.8.0 tsrs@0.18.0-ts7.1.0-dev.20260929
node docs/measurements/transfer-speed-2026-10-26/benchmark-checkers.mjs "$checker_dir"
```

Raw versions, all timing samples, and diagnostic output are in `checkers.json`. The local npm install reported an unapproved optional postinstall for tsc-rs; its executable still worked from its installed platform package. No install scripts were explicitly approved.

## Primary sources

[Theo's ts-rust repository](https://github.com/pingdotgg/ts-rust) documents the `tsc-rs` npm package and identifies it as an early Rust port of TypeScript 7. Its compatibility comparison is pinned to a specific upstream revision, not this project's TypeScript 7.0.2.

[Oxc's tsrs repository](https://github.com/oxc-project/tsrs) documents the `tsrs` package and its TypeScript 7 compiler replacement. It describes stable full conformance as a goal. Its optional fast mode can change diagnostics in known order-sensitive cases. No fast-mode flags were used here.
