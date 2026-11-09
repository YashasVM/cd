# CD transfer web SDK

Preview `0.1.0-preview.1`, ESM JavaScript with TypeScript declarations. No runtime
package dependencies, CD UI, storage selection or page lifecycle listeners.

Build a local installable package with `npm pack ./packages/transfer-web` from
the repository root. Install the resulting `.tgz` with npm. It has not been
published to the npm registry.

See [the integration guide](https://github.com/YashasVM/cd/blob/main/docs/third-party-integration.md) for consent,
streaming sinks, lifecycle, limits, compatibility and security policy. A plain
HTML host example is in `examples/transfer-web/`.
