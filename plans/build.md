# Plan: Unsigned macOS Release Build for v2

## Problem

v2 has no release packaging pipeline. We want a reproducible macOS `.dmg`
produced via GitHub Actions, with:

- Daemon bundled as a single executable via `bun build --compile`
- Daemon wired into Tauri as a sidecar (`bundle.externalBin`)
- `bundle.macOS` config + entitlements file in place
- Self-signed codesign (no Apple Developer account)
- Manual-dispatch GitHub Actions release workflow
- Target: macOS arm64 only (MVP)

No Tauri auto-updater (deferred).

## Approach (revised after rubber-duck review)

Four layers. **Three blocking issues the rubber-duck validated by actually
running `bun build --compile`** are reflected below.

### 1. Daemon → standalone bun binary — with a build-time DB split

**Blocker found:** a plain runtime `typeof Bun !== 'undefined'` branch is
insufficient. The compiled binary still carries a static import of
`better-sqlite3` and crashes at launch with
`Could not find module root ... "/$bunfs/root/daemon"`. We must ensure the
bun-targeted bundle contains **zero static references** to
`better-sqlite3` / `drizzle-orm/better-sqlite3`.

- Introduce `daemon/src/db/driver.ts` that exports a single `createDb()`
  using **dynamic `import()`**. Two sibling files — `driver.node.ts`
  (better-sqlite3) and `driver.bun.ts` (bun:sqlite) — never both statically
  imported from the same entry.
- Change **all** typed references from `BetterSQLite3Database<...>` to a
  shared `AppDatabase` type (e.g. `drizzle-orm/sqlite-core`'s
  `BaseSQLiteDatabase`). Services currently hardcode
  `BetterSQLite3Database` — each one needs retyping.
- Add a Nitro alias so the production build resolves `#db/driver` →
  `driver.bun.ts` only. Dev/tests resolve it → `driver.node.ts`.
- Verify the compiled bundle contains no `better-sqlite3` string
  (`strings dist/daemon | grep better-sqlite3` must be empty).

**Migrations — second blocker:** `daemon/src/db/index.ts` calls
`migrate(db, { migrationsFolder: './drizzle' })`. That's a relative FS path
that does not survive sidecar packaging.

Pick one of these — plan defaults to (a) because it's simplest and we
already use drizzle-kit in dev:

- **(a) Compile-in migrations.** Generate a `migrations.ts` via a small
  build step that reads `drizzle/*.sql` and inlines them as a typed array;
  write a hand-rolled migrator that runs them in a transaction keyed by a
  `__drizzle_migrations` table. No FS reads at runtime.
- **(b) Tauri resources.** Ship `daemon/drizzle/` as a Tauri `resources`
  entry; Rust resolves the absolute resource dir and passes it via env var
  (`VIBE_DRIZZLE_DIR`) to the sidecar; migrator reads that path. More
  moving parts; defer.

**Bundle script** (`daemon/scripts/bundle.mjs`):
1. Generate `src/db/migrations.generated.ts` from `drizzle/*.sql`
2. `nitro build` with the bun alias active
3. `bun build --compile --target=bun-darwin-arm64 .output/server/index.mjs --outfile dist/daemon-aarch64-apple-darwin`
4. Assert no `better-sqlite3` strings in output
5. Smoke-check: `./dist/daemon-... &` → curl `/health` → kill

**On `.well-known/`**: rubber-duck confirmed — these are **HTTP routes
emitted into `.output/server/index.mjs` by `workflow/nitro`**, not a runtime
filesystem directory. No special handling needed. What to actually validate
is workflow execution + resume under the compiled binary.

### 2. Tauri sidecar wiring

**Blocker found:** `externalBin` paths resolve relative to `src-tauri/`,
not `gui/`. The previous plan's `gui/sidecar/` location would not be found.

- Produce daemon binary at
  `gui/src-tauri/sidecar/daemon-aarch64-apple-darwin` (co-located with
  `tauri.conf.json`).
- `tauri.conf.json` → `bundle.externalBin: ["sidecar/daemon"]` (Tauri
  auto-appends the target triple).
- Extend Rust `setup` hook in `gui/src-tauri/src/lib.rs` to spawn via
  `tauri_plugin_shell::ShellExt::sidecar("daemon")`, keep `.detach()` as
  per CDD-gui.md, capture stdout/stderr into `~/.vibe-harness/logs/`.
- **Daemon lifecycle/version skew (new, flagged by rubber-duck):** current
  logic reuses any healthy daemon on `:19423`. A fresh app build could
  silently talk to an old daemon. Add a `GET /health` response field
  `buildId` (git SHA, set at bundle time via env); GUI compares to its own
  `tauri::app_handle().package_info()` + build hash; on mismatch, `kill`
  the old daemon PID from `~/.vibe-harness/daemon.pid` and respawn.
- Dev mode still uses `daemon-stub.mjs` (Rust `#[cfg(debug_assertions)]`
  path); production uses the sidecar.
- Add `.gitignore` entries: `gui/src-tauri/sidecar/daemon-*`,
  `daemon/dist/`, `daemon/src/db/migrations.generated.ts`.

### 3. Self-signed cert + minimal entitlements

Self-signed **does launch** under hardened runtime (rubber-duck confirmed),
but the cert must be a real code-signing identity.

- `scripts/setup-selfsigned-cert.sh` — OpenSSL config **must** include
  `extendedKeyUsage = codeSigning` and `keyUsage = digitalSignature`,
  otherwise `security find-identity -p codesigning` won't see it and
  `codesign` will refuse. Creates a dedicated `vibe-build.keychain`, imports
  the p12, **runs `security set-key-partition-list -S apple-tool:,apple:,codesign: -s`**
  (required for non-interactive signing).
- `gui/src-tauri/entitlements.plist` — start minimal:
  - `com.apple.security.cs.allow-jit` (Bun JIT)
  - `com.apple.security.cs.allow-unsigned-executable-memory` (Bun JIT pages)
  - Do **not** add `allow-dyld-environment-variables` or
    `disable-library-validation` unless a signed launch test proves they're
    needed. They're a blast radius we don't want by default.
- `tauri.conf.json` → `bundle.macOS`:
  ```json
  {
    "signingIdentity": "Vibe Harness Self-Signed",
    "hardenedRuntime": true,
    "entitlements": "entitlements.plist",
    "minimumSystemVersion": "12.0"
  }
  ```
- Tauri's bundler signs `externalBin` sidecars automatically with the same
  identity + entitlements → no separate codesign invocation needed, but
  verify via `codesign -dv --entitlements - Vibe\ Harness.app/Contents/MacOS/daemon`
  after the first successful build.

### 4. GitHub Actions release workflow

- `.github/workflows/release.yml`, `workflow_dispatch` only, runner
  `macos-14` (arm64, matches MVP target).
- **Inputs:** `version` optional string. Default comes from a **resolution
  step** (`jq -r .version v2/package.json`), not a dynamic default (GitHub
  Actions doesn't support dynamic `inputs.*.default`).
- Steps:
  1. `actions/checkout@v4`
  2. `actions/setup-node@v4` (20) with workspace caching
  3. `oven-sh/setup-bun@v2`
  4. `dtolnay/rust-toolchain@stable` + `Swatinem/rust-cache@v2`
  5. `npm ci` (workspaces)
  6. **Keychain setup step** (inline, not a marketplace action):
     - `security create-keychain -p "$KEYCHAIN_PASSWORD" build.keychain`
     - `security set-keychain-settings -lut 21600 build.keychain`
     - `security unlock-keychain -p "$KEYCHAIN_PASSWORD" build.keychain`
     - `echo "$CERT_B64" | base64 -d > cert.p12`
     - `security import cert.p12 -k build.keychain -P "$CERT_PASSWORD" -T /usr/bin/codesign`
     - **`security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" build.keychain`** ← critical
     - `security list-keychains -d user -s build.keychain login.keychain`
  7. `node daemon/scripts/bundle.mjs` (produces
     `gui/src-tauri/sidecar/daemon-aarch64-apple-darwin`)
  8. `cd gui && npx tauri build --target aarch64-apple-darwin`
  9. `actions/upload-artifact@v4` with
     `gui/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/*.dmg`
- **Secrets:** `MACOS_SELFSIGNED_CERT_P12_B64`, `MACOS_CERT_PASSWORD`,
  `KEYCHAIN_PASSWORD` (all repo secrets).
- No GitHub Release creation for MVP; artifact download only.

## Todos

Dependencies tracked in the SQL `todos` table.

1. `db-driver-split` — Build-time split: `driver.node.ts` / `driver.bun.ts` + dynamic import, retype services to `AppDatabase` (not `BetterSQLite3Database`)
2. `migrations-inline` — Generate `migrations.generated.ts` from `drizzle/*.sql`; hand-rolled FS-free migrator
3. `daemon-bundle-script` — `daemon/scripts/bundle.mjs` with bun alias + no-better-sqlite3 assertion + smoke test
4. `daemon-bundle-validate` — End-to-end: workflow run, hook resume, daemon restart persistence
5. `sidecar-wire` — Correct path (`src-tauri/sidecar/`), Rust setup hook, dev/prod switch, log capture
6. `daemon-version-handshake` — `/health` returns `buildId`; GUI compares + restarts mismatched daemon
7. `entitlements-plist` — **Minimal** entitlements (only `allow-jit` + `allow-unsigned-executable-memory`)
8. `selfsigned-cert-script` — OpenSSL config with `extendedKeyUsage=codeSigning`, keychain + `set-key-partition-list`
9. `tauri-macos-config` — `bundle.macOS` signing block; verify sidecar inherits signing
10. `ci-release-workflow` — `.github/workflows/release.yml` with correct keychain incantations and dynamic-version resolution step
11. `docs-update` — `v2/README.md` release section + `docs/BUILDING-macos.md` (xattr quarantine caveat for users)

## Notes / Risks (updated)

- **Three dead ends avoided** (rubber-duck validated empirically):
  1. Static `better-sqlite3` import → crash in compiled binary
  2. `./drizzle` relative path for migrations → broken in sidecar
  3. `externalBin` path relative to `src-tauri/`, not `gui/`
- **Cert must be real code-signing identity** — missing `extendedKeyUsage`
  silently breaks `codesign`. Script must set it explicitly.
- **CI keychain gotcha** — `set-key-partition-list` is the most commonly
  missed step; without it, signing fails with
  `User interaction is not allowed`.
- **Version skew via port 19423 reuse** — build handshake required, not
  optional.
- **`workflow_dispatch` dynamic default** — not supported by GitHub Actions;
  resolved in a step instead.
- **Entitlements minimalism** — start with 2, add only on demonstrated need.
- **No notarization** — users still need
  `xattr -dr com.apple.quarantine /Applications/Vibe\ Harness.app` on first
  launch. Documented.
- **arm64 only.** x86_64/universal deferred.
- **Ad-hoc `codesign -s -` remains cheaper** and gives equivalent end-user
  UX. User chose self-signed; we document both so the decision can be
  revisited without rework (both paths share the same entitlements file
  and externalBin wiring).
