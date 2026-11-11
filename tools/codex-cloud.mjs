// codex-cloud.mjs — start and read OpenAI Codex Cloud jobs on NEW-generation environments,
// which the stock `codex cloud` commands cannot see (openai/codex issues 50182, 56995).
// Uses the Codex CLI's own ChatGPT login (~/.codex/auth.json); nothing secret is stored here.
// Talks to private, undocumented web-app endpoints: may break without notice.
//
//   node codex-cloud.mjs envs
//   node codex-cloud.mjs start <env-name> "<prompt>" [--sandbox workspace-write]
//   node codex-cloud.mjs status <threadId>        -> prints JSON {status, lastMessage, ...}
//   node codex-cloud.mjs send <threadId> "<follow-up prompt>"
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const tok = () => JSON.parse(readFileSync(homedir() + '/.codex/auth.json', 'utf8')).tokens;

async function envs() {
  const t = tok();
  const r = await fetch('https://chatgpt.com/api/codex-cloud/v1/environment-configs?scope=user&limit=100&omitDraft=true',
    { headers: { Authorization: 'Bearer ' + t.access_token, 'ChatGPT-Account-Id': t.account_id, Accept: 'application/json' } });
  if (!r.ok) throw new Error('environment list failed: ' + r.status + ' ' + (await r.text()).slice(0, 300));
  const j = await r.json();
  return j.items ?? j.data ?? j;
}

// Minimal JSON-RPC client over the WebSocket used by the Codex web app.
async function connect() {
  const ws = new WebSocket('wss://codex-cloud-backend.chatgpt.com/',
    ['codex-app-server', 'codex-client.browser', 'openai-bearer.' + tok().access_token]);
  let next = 1; const pending = new Map(); const listeners = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== undefined && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    } else if (m.method) listeners.forEach((f) => f(m));
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WebSocket failed to open')); });
  const call = (method, params) => new Promise((res, rej) => {
    const id = next++; pending.set(id, { res, rej }); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
  await call('initialize', { clientInfo: { name: 'herdr-codex-cloud', version: '0.1' }, capabilities: { experimentalApi: true } });
  ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }));
  return { call, on: (f) => listeners.push(f), close: () => ws.close() };
}

const userInput = (text) => ({ clientUserMessageId: randomUUID(), input: [{ type: 'text', text, text_elements: [] }] });

async function start(envName, prompt, sandbox) {
  const env = (await envs()).find((e) => e.name === envName || e.id === envName);
  if (!env) throw new Error('no environment named ' + envName);
  const c = await connect();
  const params = { environments: [{ environmentConfigId: env.id, cwd: '/workspace' }], deferredEnvironment: true,
    config: { 'features.mcp_app_ui': true }, pluginsMcp: { productSku: 'codex' } };
  if (sandbox) params.sandbox = sandbox;
  const { thread } = await c.call('thread/start', params);
  await c.call('turn/start', { threadId: thread.id, ...userInput(prompt) });
  console.log(JSON.stringify({ threadId: thread.id, environment: env.name }));
  c.close();
}

async function status(threadId) {
  const c = await connect();
  const r = await c.call('thread/turns/list', { threadId, itemsView: 'full' });
  c.close();
  const turns = r.turns ?? r.data ?? [];
  const last = turns.at(-1) ?? {};
  const items = last.items ?? [];
  const msgs = items.filter((i) => i.type === 'agentMessage');
  console.log(JSON.stringify({ status: last.status ?? 'unknown', turns: turns.length,
    lastMessage: msgs.at(-1)?.text ?? null,
    commands: items.filter((i) => i.type === 'commandExecution').map((i) => ({ cmd: i.command, exit: i.exitCode })) }, null, 1));
}

async function send(threadId, prompt) {
  const c = await connect();
  await c.call('thread/resume', { threadId });
  await c.call('turn/start', { threadId, ...userInput(prompt) });
  console.log(JSON.stringify({ threadId, sent: true }));
  c.close();
}

const [cmd, a, b, ...rest] = process.argv.slice(2);
const sandbox = rest[0] === '--sandbox' ? rest[1] : undefined;
try {
  if (cmd === 'envs') console.log(JSON.stringify((await envs()).map((e) => ({ name: e.name, id: e.id })), null, 1));
  else if (cmd === 'start') await start(a, b, sandbox);
  else if (cmd === 'status') await status(a);
  else if (cmd === 'send') await send(a, b);
  else { console.error('usage: envs | start <env> "<prompt>" [--sandbox mode] | status <threadId> | send <threadId> "<prompt>"'); process.exit(2); }
} catch (e) { console.error('ERROR:', e.message); process.exit(1); }
process.exit(0);
