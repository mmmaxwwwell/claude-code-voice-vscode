# Phase phase1-setup — Review #1: REVIEW-CLEAN

**Date**: 2026-03-25T00:00:00Z
**Assessment**: Code is clean. No bugs, security issues, or correctness problems found.

**Deferred** (optional improvements, not bugs):
- `__main__.py:_start_listening` registers shutdown hooks (`audio_stream_stop`, `pipeline_teardown`) on every call without deduplication — hooks accumulate if listening is toggled repeatedly. Not a crash risk (lambdas guard against None) but wasteful during shutdown.
- `shutdown.py:60` uses deprecated `asyncio.get_event_loop()` instead of `asyncio.get_running_loop()` — works correctly since `shutdown()` is always called from an async context, but should be updated for Python 3.12+ compatibility.
- `extension.ts:87-95` uses a hardcoded 500ms `setTimeout` before connecting to the sidecar socket — fragile timing assumption, could be replaced with a retry/poll mechanism.
