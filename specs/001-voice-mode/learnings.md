# Learnings

Discoveries, gotchas, and decisions recorded by the implementation agent across runs.

---

- **T002**: VS Code `contributes` in package.json does not support declarative status bar items. Status bar items must be created programmatically via `vscode.window.createStatusBarItem()` in the extension code (T021). The task description mentions "status bar item" in contributes but this is not possible in the manifest.
- **T002**: Used `engines.vscode: "^1.85.0"` to match `@types/vscode` version — this is a reasonable baseline for 2024+ VS Code features.
- **T004**: `npm` and `node` are only available inside `nix develop` shell — all commands must be run via `nix develop --command bash -c "..."`.
- **T004**: Created `scripts/build.mjs` using esbuild JS API instead of inline CLI in package.json — cleaner and extensible. A minimal `src/extension.ts` stub is needed for typecheck and build to pass.
- **T005**: Audio fixture generator uses stdlib only (no numpy) for synthetic mode, so it works outside the nix devshell. The `--tts` mode requires piper-tts + numpy for realistic speech. Synthetic fixtures use modulated tone bursts that should activate VAD but won't produce meaningful transcriptions — downstream tests needing real transcription should use `--tts` regenerated fixtures.
- **T008**: `uv sync --dev` requires `[tool.uv] dev-dependencies` (or `[dependency-groups] dev`) — the `[project.optional-dependencies] dev` section alone is NOT sufficient. Without the uv-specific section, `uv sync --dev` actually *uninstalls* pytest. Added `[tool.uv] dev-dependencies` to pyproject.toml to fix.
- **T010**: `sounddevice` loads libportaudio.so.2 at import time, which fails in nix environments where the library path isn't set. Use lazy import (`_import_sounddevice()` helper) so the module can be imported and tested without the native library. Tests mock `_import_sounddevice` rather than `sidecar.audio.sd`.
- **T010**: For unit tests of callback-based audio streams, avoid threading. Instead: (1) put frames on the queue synchronously in a fake InputStream `__enter__`, (2) append a `None` sentinel to stop the consumer loop. File source mode (`file_source=` parameter) needs no mocking at all.
- **T010**: `LD_LIBRARY_PATH` in the nix devshell doesn't include portaudio or stdenv.cc.cc.lib — numpy and sounddevice both need these. Use `nix eval --raw nixpkgs#stdenv.cc.cc.lib`/lib and `nix eval --raw nixpkgs#portaudio`/lib.
- **T011**: `webrtcvad` fails to import in nix because it depends on `pkg_resources` (setuptools) at import time. Same pattern as sounddevice: use lazy import (`_import_webrtcvad()`) and dependency injection (`_webrtcvad_mod` / `_silero_fn` constructor kwargs) for testability. This avoids `@patch` on module-level imports entirely.
- **T011**: For components with heavy native dependencies (webrtcvad, onnxruntime), constructor-based dependency injection (`_webrtcvad_mod=`, `_silero_fn=`) is cleaner than `@patch` decorators — no import-order issues, no `AttributeError: module has no attribute` from patch targets.
