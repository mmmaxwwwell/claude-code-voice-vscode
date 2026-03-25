/**
 * Vitest custom reporter producing structured JSON output.
 *
 * Output directory: test-logs/unit-ts/<timestamp>/
 *   - summary.json: overall results with pass/fail counts and timing
 *   - failures/<test-name>.log: per-failure details with assertion + stack trace
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default class JsonSummaryReporter {
  /** @type {string} */
  #outDir;
  /** @type {string} */
  #failDir;
  /** @type {string} */
  #timestamp;

  constructor() {
    this.#timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.#outDir = join('test-logs', 'unit-ts', this.#timestamp);
    this.#failDir = join(this.#outDir, 'failures');
  }

  onInit() {
    mkdirSync(this.#failDir, { recursive: true });
  }

  onFinished(files) {
    const tests = [];
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    let totalDuration = 0;

    for (const file of files ?? []) {
      for (const task of flattenTasks(file)) {
        const name = taskName(task);
        const duration = task.result?.duration ?? 0;
        totalDuration += duration;

        if (task.result?.state === 'pass') {
          passed++;
          tests.push({ name, status: 'passed', duration });
        } else if (task.result?.state === 'fail') {
          failed++;
          tests.push({ name, status: 'failed', duration });
          this.#writeFailureLog(name, task);
        } else if (task.mode === 'skip' || task.mode === 'todo') {
          skipped++;
          tests.push({ name, status: 'skipped', duration: 0 });
        }
      }
    }

    const summary = {
      timestamp: this.#timestamp,
      totalTests: passed + failed + skipped,
      passed,
      failed,
      skipped,
      durationMs: Math.round(totalDuration),
      tests,
    };

    writeFileSync(
      join(this.#outDir, 'summary.json'),
      JSON.stringify(summary, null, 2) + '\n',
    );
  }

  /**
   * Write a failure log file with assertion details and stack trace.
   */
  #writeFailureLog(name, task) {
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
    const lines = [`Test: ${name}`, `File: ${task.file?.name ?? 'unknown'}`, ''];

    for (const err of task.result?.errors ?? []) {
      if (err.message) {
        lines.push('--- Assertion ---');
        lines.push(err.message);
        lines.push('');
      }
      if (err.stack) {
        lines.push('--- Stack Trace ---');
        lines.push(err.stack);
        lines.push('');
      }
      if (err.diff) {
        lines.push('--- Diff ---');
        lines.push(err.diff);
        lines.push('');
      }
    }

    writeFileSync(join(this.#failDir, `${safeName}.log`), lines.join('\n'));
  }
}

/** Recursively collect all leaf test tasks from a file/suite. */
function flattenTasks(suite) {
  const results = [];
  for (const task of suite.tasks ?? []) {
    if (task.tasks) {
      results.push(...flattenTasks(task));
    } else {
      results.push(task);
    }
  }
  return results;
}

/** Build a fully-qualified test name from the task hierarchy. */
function taskName(task) {
  const parts = [];
  let current = task;
  while (current) {
    if (current.name) parts.unshift(current.name);
    current = current.suite;
  }
  return parts.join(' > ');
}
