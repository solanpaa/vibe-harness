# Migration: Docker `sbx` → microsandbox

The sandbox runtime was ported from [Docker AI Sandboxes (`sbx`)](https://docs.docker.com/ai/sandboxes/)
to [microsandbox](https://github.com/superradcompany/microsandbox) (npm `microsandbox`,
NAPI-bound microVM SDK).

## What this means for users

### Removed prerequisites
- Docker Desktop with `sbx` plugin is no longer required.
- The host-side `sbx policy allow network localhost:<port>` bootstrap is gone — daemon startup no longer touches host network policy.

### New prerequisites
- macOS Apple Silicon, or Linux with KVM enabled.
- Node.js 22+ (microsandbox NAPI addon requirement).
- Either Docker (with `buildx`) or Podman on PATH for building agent images. Microsandbox boots images directly from the host docker/podman image cache.

### What stays the same
- Agent definitions and Dockerfiles are unchanged. Existing `dockerImage` / `dockerfile` columns are reused.
- `POST /api/agents/:id/build` still streams build progress over SSE; only the underlying pipeline shrank (no `docker save` + `sbx template load` step — microsandbox boots the image from your local docker/podman cache directly).
- Credentials, env vars, mounts, GitHub account selection, ACP semantics, workflow templates — all unchanged.

### What changed
- **Sandbox lifecycle**: sandboxes now run in *attached* mode and exit with the daemon. Reboot survival is no longer supported. (To resume mid-flight work after a daemon restart, re-run the failed stage; the workflow engine handles this via the existing review-gate/retry mechanism.)
- **Network policy**: each sandbox now gets a per-VM network policy enforced by the microsandbox stack. Defaults: deny-egress with `allow @public` + `allow @host`. The in-sandbox MCP bridge reaches the daemon at `host.microsandbox.internal:<port>` (was `host.docker.internal:<port>`).
- **Credential injection**: env vars are now native (`Sandbox.builder().env(K, V)`); credential mounts are native readonly volumes. `/etc/sandbox-persistent.sh` is gone.
- **Image lookup**: `sbx template ls` is replaced by `docker image inspect` / `podman image inspect` / SDK image cache. The pre-flight check on `POST /api/runs` now reports `AGENT_IMAGE_MISSING` if the image is not in any of those caches.

### Deferred follow-ups (not in this port)
- Per-project network-policy DB columns (deny domains/suffixes, DNS knobs, trust-host-CAs). The `SandboxNetworkConfig` type is wired through but not yet persisted.
- Per-sandbox log surfacing endpoint (microsandbox provides `Sandbox.logs()` with `system` and `all` sources for runtime/kernel diagnostics).
- Idle-timeout / max-duration enforcement (`Sandbox.builder().idleTimeout()` / `.maxDuration()`).

### Rolling forward
1. Stop the daemon and any in-flight runs (they will be marked `stage_failed` on next startup).
2. Pull the new code; `npm install` will fetch the `microsandbox` package and its NAPI binary for your platform.
3. Restart the daemon; `lib/sandbox-prereqs.ts` logs whether the SDK loaded successfully.
4. Re-run `POST /api/agents/:id/build` for any agent whose image was previously in the legacy `sbx template store` — it must now be present in your host docker/podman cache.
