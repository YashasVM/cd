# cdx

`cdx` is the CD command-line transfer tool: send files and folders between
computers with end-to-end encryption, and optionally share the receive code
by email.

## CD additions

- `cdx login` — save SMTP credentials (stored with owner-only permissions in
  `~/.config/cdx/login.json`) so transfers can be shared by email.
- `cdx login --status` / `cdx login --logout` — inspect or remove saved
  credentials.
- `cdx send --mail <address>` — email the share code and receive instructions
  to someone before starting a transfer.

Example:

```
cdx login --smtp-host smtp.gmail.com --smtp-port 587 -u me@gmail.com
cdx send --mail friend@example.com report.pdf
```

The recipient runs:

```
cdx <code>
```

Files are end-to-end encrypted; only someone with the code can receive them,
and the sender must keep the session running until the transfer completes.

## Upstream attribution

This lane is derived from [schollz/croc](https://github.com/schollz/croc)
(MIT License). Croc's MIT license text is preserved in [`LICENSE`](LICENSE),
as required by its terms. CD is not affiliated with or endorsed by the croc
project; all modifications are by the CD project (Apache-2.0, see the
repository root).
