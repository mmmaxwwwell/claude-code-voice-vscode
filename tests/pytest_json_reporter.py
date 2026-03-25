"""
pytest plugin producing structured JSON test output.

Output directory: test-logs/unit-python/<timestamp>/
  - summary.json: overall results with pass/fail counts and timing
  - failures/<test-name>.log: per-failure details with assertion + stack trace
"""

from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path


def pytest_addoption(parser):
    parser.addoption(
        "--json-report-dir",
        default="test-logs/unit-python",
        help="Base directory for JSON test reports",
    )


def pytest_configure(config):
    config.pluginmanager.register(JsonReportPlugin(config), "json_report_plugin")


class JsonReportPlugin:
    def __init__(self, config):
        self.config = config
        self.timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-%fZ")
        base = config.getoption("--json-report-dir", default="test-logs/unit-python")
        self.out_dir = Path(base) / self.timestamp
        self.fail_dir = self.out_dir / "failures"
        self.results: list[dict] = []
        self.start_time = 0.0

    def pytest_sessionstart(self, session):
        self.start_time = time.monotonic()
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.fail_dir.mkdir(parents=True, exist_ok=True)

    def pytest_runtest_logreport(self, report):
        # Only record the "call" phase (not setup/teardown), or collect-phase errors
        if report.when != "call" and not (
            report.when == "setup" and report.failed
        ):
            return

        duration_ms = round(report.duration * 1000, 1)

        if report.passed:
            self.results.append(
                {"name": report.nodeid, "status": "passed", "duration": duration_ms}
            )
        elif report.failed:
            self.results.append(
                {"name": report.nodeid, "status": "failed", "duration": duration_ms}
            )
            self._write_failure_log(report)
        elif report.skipped:
            self.results.append(
                {"name": report.nodeid, "status": "skipped", "duration": 0}
            )

    def pytest_sessionfinish(self, session, exitstatus):
        passed = sum(1 for r in self.results if r["status"] == "passed")
        failed = sum(1 for r in self.results if r["status"] == "failed")
        skipped = sum(1 for r in self.results if r["status"] == "skipped")
        total_duration = round((time.monotonic() - self.start_time) * 1000)

        summary = {
            "timestamp": self.timestamp,
            "totalTests": passed + failed + skipped,
            "passed": passed,
            "failed": failed,
            "skipped": skipped,
            "durationMs": total_duration,
            "tests": self.results,
        }

        summary_path = self.out_dir / "summary.json"
        summary_path.write_text(json.dumps(summary, indent=2) + "\n")

    def _write_failure_log(self, report):
        safe_name = re.sub(r"[^a-zA-Z0-9_-]", "_", report.nodeid)[:200]
        lines = [f"Test: {report.nodeid}", ""]

        if report.longreprtext:
            lines.append("--- Assertion Details ---")
            lines.append(report.longreprtext)
            lines.append("")

        if hasattr(report, "capstdout") and report.capstdout:
            lines.append("--- Captured stdout ---")
            lines.append(report.capstdout)
            lines.append("")

        if hasattr(report, "capstderr") and report.capstderr:
            lines.append("--- Captured stderr ---")
            lines.append(report.capstderr)
            lines.append("")

        log_path = self.fail_dir / f"{safe_name}.log"
        log_path.write_text("\n".join(lines))
