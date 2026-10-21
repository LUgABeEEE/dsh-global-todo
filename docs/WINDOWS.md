# Windows

Issue #2 was a Windows-only save failure that shipped for months because CI only ever ran Linux:
the atomic write reopened its temp file read-only and called `fsync`, which on Windows is
`FlushFileBuffers` and requires a writable handle. Every save threw `EPERM` **before** the rename,
so the list looked empty while the data piled up as `*.tmp` debris. Fixed in 0.12.6.

This file is the checklist that keeps that from happening again, and the script a tester on a real
Windows machine should run.

## What the test suite already covers on every platform

| Area | Where | What it pins |
|---|---|---|
| atomic write | `test/atomic-write.test.mjs` | the temp file is opened for **writing**; a refused `fsync` warns instead of losing the save; a failed write leaves no debris |
| rename under a lock | `test/windows.test.mjs` | `EPERM`/`EBUSY`/`EACCES` are retried (bounded), other errors fail at once, no temp file survives a real failure |
| workspace paths | `test/windows.test.mjs` | `C:\\dev\\demo`, `C:/dev/demo` and `\\\\server\\share` are accepted as exemptions; relative paths are not |
| CRLF markdown | `test/windows.test.mjs` | a document saved on Windows imports like the same document saved on Linux |
| install shape | `test/manifest.test.mjs` | `locale/` ships and the `./locale/*.json` export exists (the desktop metadata error) |

CI runs the suite on **ubuntu-latest and windows-latest** (node 22.19 on both, node 24 on Linux).
Windows runs `node tools/windows-check.mjs` as an extra step.

## The real-filesystem check

```powershell
git clone https://github.com/LUgABeEEE/dsh-global-todo
cd dsh-global-todo
node tools/windows-check.mjs      # or: npm run check:windows
```

It uses `os.tmpdir()` and does seven things a faked `fs` cannot: create a store, update/complete/
review then reload, assert no `.tmp` debris, write and read back 500 todos, import a CRLF Markdown
file, write into a path with spaces and non-ASCII characters, and rename over an existing file. It
prints one line per check and exits non-zero on the first failure.

## What to report if something fails

1. the check name from the `FAIL` line and the full message;
2. `node -v`, `dsh --version`, Windows build (`winver`);
3. whether the data directory is on a network drive, OneDrive, or a synced folder — those change
   `fsync`/`rename` semantics more than the OS version does;
4. the contents of `%USERPROFILE%\.dsh\global-todo\` (file names are enough; redact titles if you
   prefer) — `*.tmp` files are evidence of a write that never renamed.

## Known Windows behaviours that are *not* bugs

- **A `*.tmp` file can briefly appear** while a write is in flight. After a successful save it is
  gone; after a failed one it is removed by the writer.
- **Antivirus can hold a handle for a few milliseconds.** That is why the rename is retried rather
  than reported on the first `EPERM`.
- **Paths longer than 260 characters** depend on the machine's `LongPathsEnabled` policy; the plugin
  uses normal Node file APIs, so it inherits that limit rather than working around it.
- **Case**: workspace exemptions are compared case-insensitively on Windows only.
