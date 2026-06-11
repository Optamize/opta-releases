# Opta Releases

Signed release artifacts and update manifests for the Opta Stack desktop fleet
(Opta HQ · Opta Gateway · Opta Deploy · Opta Life · Opta Dev Lab).

- **Binaries** attach to [GitHub Releases](../../releases) on this repo (tag scheme: `<app-id>-v<semver>`).
- **Update manifests** live under `public/v1/apps/<app-id>/<channel>/latest.json` — stock
  [Tauri updater static format](https://v2.tauri.app/plugin/updater/). Beside each, `release.meta.json`
  (schema `opta.release-meta/1`) carries the update class (`hotfix` | `feature`), highlights, and the
  release → Atlas-modules map.
- **Channels**: `stable/` and `beta/`. Promotion = manifest copy; artifacts are byte-identical.
- `history/` is the immutable archive of every manifest ever published. `latest.json` is the only
  mutable file; git history is the audit log.
- `public/v1/feeds/` is reserved for the content plane (Atlas catalogue, status, Learn — U2).
- All artifacts are minisign-signed (fleet key `235BA81E06B7EAFA`) and macOS bundles are
  Developer-ID signed + notarized. Source code is **not** in this repo.

Design authority: the Opta Update System foundation design (internal, 2026-06-11).
