# Reviewed secret-scanner false positives

The 14 exact fingerprints added to `.gitleaksignore` on 2026-10-19 were
reproduced with Gitleaks 8.30.1 against repository history, with redacted output.
No rule or path has been disabled. The exemptions bind to specific commits,
paths, rules, and lines, so future unrelated credentials remain scanned.

- `fixtures/transfer-v1.json` (2 findings): fixed sequential-byte invitation
  key and its derived receiver admission token. `TestAndroidLegacyFixtureMatchesCLI`
  verifies the vector against the CLI's deterministic test invitation.
- `fixtures/device-v1.json` (10 findings across two commits): fixed
  sequential-byte pairing seed and four HKDF-derived sender/receiver keys or
  admission tokens. The Go and Android interoperability tests verify these
  public protocol vectors; they are not credentials for a user account.
- `scripts/v2-browser-diagnostics.test.mjs` (1 finding): a literal repeated
  dummy string used to test diagnostic redaction.
- Historical `docs/measurements/transfer-speed-2026-10-18/provenance.json`
  (1 finding): the SHA256 digest of `scripts/verify-resume-auth.mjs`, verified
  against that file's bytes at the same historical commit. It is not a secret.

Do not add broad fixture-directory allowlists. Review any new finding
individually, and retain redaction when saving scanner output.
