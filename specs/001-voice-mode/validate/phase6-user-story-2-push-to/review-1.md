# Phase phase6-user-story-2-push-to — Review #1: REVIEW-CLEAN

**Date**: 2026-03-25
**Assessment**: Code is clean. No bugs, security issues, or correctness problems found.

Both integration tests (`sidecar-ptt.test.ts`, `sidecar-ptt-cancel.test.ts`) follow the established pattern from `sidecar-wake.test.ts`, correctly use the PTT protocol flow (config with `pushToTalk` mode, `control:start`, `ptt_start`, delay for audio consumption, `ptt_stop`), and assert the expected message sequence. Audio fixtures exist. Protocol types are used correctly.

**Deferred** (optional improvements, not bugs):
- All three integration tests (`sidecar-wake`, `sidecar-ptt`, `sidecar-ptt-cancel`) share ~80% identical boilerplate (`connectWithRetry`, `waitForCondition`, socket setup/teardown, message collection). A shared test helper module could reduce duplication.
- Failed socket connections in `connectWithRetry` are not explicitly `.destroy()`ed before retry — minor resource leak during test setup retries.
- The `earlyExitPromise` rejection handler stays attached after `Promise.race` resolves, which could cause unhandled rejection warnings if the sidecar exits during normal test teardown.
