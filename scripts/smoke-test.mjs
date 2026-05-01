/**
 * Drives the MCP server with a synthetic JSON-RPC client over stdio.
 * Verifies: initialize → tools/list → tools/call(list_accounts) → tools/call(list_recurring_series).
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
  if (!names.includes('list_accounts') || !names.includes('list_recurring_series')) {
    throw new Error('expected tools missing');
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

  // 5. error path: invalid accountId
  const errCall = await send('tools/call', {
    name: 'list_recurring_series',
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
