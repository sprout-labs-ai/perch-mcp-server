/**
 * Drives the MCP server with a synthetic JSON-RPC client over stdio.
 * Verifies the full v0.2 tool surface end-to-end:
 *   initialize → tools/list → tools/call for each of the 5 tools → an error path.
 *
 * Run: PERCH_API_URL=http://localhost:3000 PERCH_API_TOKEN=pat_… node scripts/smoke-test.mjs
 */

import { spawn } from 'node:child_process';
import readline from 'node:readline';

const child = spawn('node', ['./dist/index.js'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
});

const rl = readline.createInterface({ input: child.stdout });

const pending = new Map();
let nextId = 1;

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { console.error('non-JSON line:', line); return; }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  }
});

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout on ${method}`));
      }
    }, 10000);
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

async function run() {
  // 1. initialize
  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '0.0.0' },
  });
  console.log('✓ initialize → server name:', init.result?.serverInfo?.name);

  notify('notifications/initialized', {});

  // 2. tools/list
  const tools = await send('tools/list', {});
  const names = tools.result.tools.map((t) => t.name);
  console.log('✓ tools/list →', names.join(', '));
  const expected = [
    'list_accounts',
    'list_recurring_series',
    'list_scheduled_items',
    'get_forecast_curve',
    'simulate_forecast',
  ];
  for (const e of expected) {
    if (!names.includes(e)) throw new Error(`expected tool missing: ${e}`);
  }

  // 3. tools/call list_accounts
  const accounts = await send('tools/call', {
    name: 'list_accounts',
    arguments: {},
  });
  const accountsText = accounts.result?.content?.[0]?.text;
  if (!accountsText) throw new Error('list_accounts returned no text content');
  const parsed = JSON.parse(accountsText);
  console.log(`✓ list_accounts → ${parsed.accounts.length} account(s), default=${parsed.defaultAccountId}`);
  if (parsed.accounts.length === 0) {
    console.warn('  (no accounts in dev DB — list_recurring_series will be skipped)');
    child.kill();
    return;
  }

  // 4. tools/call list_recurring_series with the default (or first) account
  const accountId = parsed.defaultAccountId || parsed.accounts[0].id;
  const series = await send('tools/call', {
    name: 'list_recurring_series',
    arguments: { accountId },
  });
  const seriesText = series.result?.content?.[0]?.text;
  if (!seriesText) throw new Error('list_recurring_series returned no text content');
  const seriesParsed = JSON.parse(seriesText);
  console.log(`✓ list_recurring_series(${accountId}) → ${seriesParsed.count} active series`);

  // 5. tools/call list_scheduled_items
  const sched = await send('tools/call', {
    name: 'list_scheduled_items',
    arguments: { accountId },
  });
  const schedText = sched.result?.content?.[0]?.text;
  if (!schedText) throw new Error('list_scheduled_items returned no text content');
  const schedParsed = JSON.parse(schedText);
  console.log(
    `✓ list_scheduled_items(${accountId}) → ${schedParsed.count} item(s) in ${schedParsed.window.from}..${schedParsed.window.to}, net ${schedParsed.netForWindow}`,
  );

  // 6. tools/call get_forecast_curve (event granularity for terser output)
  const curve = await send('tools/call', {
    name: 'get_forecast_curve',
    arguments: { accountId, days: 30, granularity: 'event' },
  });
  const curveText = curve.result?.content?.[0]?.text;
  if (!curveText) throw new Error('get_forecast_curve returned no text content');
  const curveParsed = JSON.parse(curveText);
  console.log(
    `✓ get_forecast_curve(${accountId}, 30d) → start ${curveParsed.startingBalance} → end ${curveParsed.endBalance} (${curveParsed.points.length} points, ${curveParsed.eventCount} events)`,
  );

  // 7. tools/call simulate_forecast (with a -$500 hypothetical mid-window)
  const future = new Date();
  future.setUTCDate(future.getUTCDate() + 14);
  const hypoDate = future.toISOString().slice(0, 10);
  const sim = await send('tools/call', {
    name: 'simulate_forecast',
    arguments: {
      accountId,
      days: 30,
      granularity: 'event',
      hypotheticalItems: [
        { occursOn: hypoDate, amount: '-500.00', description: 'Smoke test surprise expense' },
      ],
    },
  });
  const simText = sim.result?.content?.[0]?.text;
  if (!simText) throw new Error('simulate_forecast returned no text content');
  const simParsed = JSON.parse(simText);
  console.log(
    `✓ simulate_forecast → end ${simParsed.endBalance} (vs baseline ${curveParsed.endBalance}, applied ${simParsed.appliedHypotheticals})`,
  );
  const baselineEnd = parseFloat(curveParsed.endBalance);
  const simEnd = parseFloat(simParsed.endBalance);
  if (Math.abs((baselineEnd - simEnd) - 500) > 0.01) {
    throw new Error(`simulate impact off: expected -500 difference, got ${(baselineEnd - simEnd).toFixed(2)}`);
  }
  console.log('  └─ impact matches: -$500 hypothetical reduced end balance by exactly $500');

  // 8. error path: invalid accountId on the new tools
  const errCall = await send('tools/call', {
    name: 'list_scheduled_items',
    arguments: { accountId: '00000000-0000-0000-0000-000000000000' },
  });
  if (errCall.result?.isError) {
    console.log('✓ invalid accountId surfaces as tool error (expected)');
  } else if (errCall.error) {
    console.log('✓ invalid accountId surfaces as JSON-RPC error (expected)');
  } else {
    console.warn('? invalid accountId returned a non-error result — check perch-api response');
  }

  child.kill();
}

run().catch((err) => {
  console.error('✗', err);
  child.kill();
  process.exit(1);
});

child.on('exit', (code) => {
  if (code !== 0 && code !== null) process.exit(code);
});
