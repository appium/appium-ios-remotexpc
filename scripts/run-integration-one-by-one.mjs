#!/usr/bin/env node
/**
 * Run integration npm scripts sequentially with a hard wall-clock cap per suite.
 * Mocha --timeout only limits individual tests; this kills the whole process.
 */
import { spawn } from 'node:child_process';

const SUITE_MS = Number.parseInt(process.env.SUITE_TIMEOUT_MS || '60000', 10);
const MOCHA_TEST_MS = Number.parseInt(process.env.MOCHA_TEST_MS || '55000', 10);

/** npm script names to skip (e.g. notification-proxy hangs). */
const SKIP = new Set(
  (process.env.SKIP_INTEGRATION || 'test:notification')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const NPM_SUITES = [
  'test:tunnel',
  'test:pair-record',
  'test:diagnostics',
  'test:notification',
  'test:image-mounter',
  'test:mobile-config',
  'test:springboard',
  'test:discovery',
  'test:webinspector',
  'test:misagent',
  'test:afc',
  'test:lockdown-tunnel',
  'test:crash-reports',
  'test:house-arrest',
  'test:installation-proxy',
  'test:power-assertion',
  'test:dvt',
  'test:dvt:graphics',
  'test:dvt:location-simulation',
  'test:dvt:condition-inducer',
  'test:dvt:screenshot',
  'test:dvt:device-info',
  'test:dvt:applist',
  'test:dvt:notification',
  'test:dvt:network-monitor',
  'test:dvt:process-control',
  'test:testmanagerd',
];

const MOCHA_FILES = ['test/integration/port-forwarding-test.ts'];

function runCommand(label, command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      detached: true,
    });

    let out = '';
    const append = (chunk) => {
      out += chunk.toString();
      process.stdout.write(chunk);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, SUITE_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        label,
        code: killed ? 124 : (code ?? 1),
        timedOut: killed,
        out,
      });
    });
  });
}

function summarize(out) {
  const stats =
    out.match(/(\d+) passing/g)?.join(', ') ||
    out.match(/(\d+) failing/g)?.join(', ') ||
    '';
  return stats;
}

async function main() {
  const only = process.argv.slice(2);
  const suites = only.length
    ? NPM_SUITES.filter((s) => only.includes(s))
    : NPM_SUITES;
  const mochaFiles = only.length
    ? MOCHA_FILES.filter((f) => only.some((o) => f.includes(o)))
    : MOCHA_FILES;

  if (!process.env.UDID) {
    console.warn('WARN: UDID is not set — device suites will fail or skip.');
  }

  const results = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let timedOut = 0;

  for (const suite of suites) {
    console.log(`\n========== RUN ${suite} (max ${SUITE_MS}ms) ==========`);
    if (SKIP.has(suite)) {
      console.log(`SKIP ${suite}`);
      results.push({ label: suite, status: 'SKIP' });
      skipped++;
      continue;
    }

    const result = await runCommand(
      suite,
      'npm',
      ['run', suite, '--', '--timeout', String(MOCHA_TEST_MS)],
    );

    const tail = result.out.split('\n').slice(-15).join('\n');
    if (result.timedOut) {
      console.error(`\n*** TIMED OUT after ${SUITE_MS}ms ***\n${tail}`);
      results.push({ label: suite, status: 'TIMEOUT' });
      timedOut++;
      failed++;
      continue;
    }

    if (result.code === 0) {
      results.push({
        label: suite,
        status: 'PASS',
        stats: summarize(result.out),
      });
      passed++;
    } else {
      console.error(`\n*** FAILED (exit ${result.code}) ***\n${tail}`);
      results.push({
        label: suite,
        status: 'FAIL',
        code: result.code,
        stats: summarize(result.out),
      });
      failed++;
    }
  }

  for (const file of mochaFiles) {
    const label = file.split('/').pop();
    console.log(`\n========== RUN ${label} (max ${SUITE_MS}ms) ==========`);
    const result = await runCommand(label, 'npx', [
      'mocha',
      file,
      '--exit',
      '--timeout',
      String(MOCHA_TEST_MS),
    ]);
    if (result.timedOut) {
      results.push({ label, status: 'TIMEOUT' });
      timedOut++;
      failed++;
    } else if (result.code === 0) {
      results.push({ label, status: 'PASS', stats: summarize(result.out) });
      passed++;
    } else {
      results.push({ label, status: 'FAIL', code: result.code });
      failed++;
    }
  }

  console.log('\n========== SUMMARY ==========');
  for (const r of results) {
    const extra = [r.stats, r.code !== undefined ? `exit ${r.code}` : '']
      .filter(Boolean)
      .join(' ');
    console.log(`${r.status.padEnd(7)} ${r.label}${extra ? ` (${extra})` : ''}`);
  }
  console.log(
    `Passed: ${passed}  Failed: ${failed}  Skipped: ${skipped}  Timed out: ${timedOut}`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

await main();
