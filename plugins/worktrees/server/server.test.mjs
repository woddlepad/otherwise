import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const SERVER_PATH = fileURLToPath(new URL('../dist/server.mjs', import.meta.url))
const REQUEST_TIMEOUT_MS = 10_000

function client(t) {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'worktrees-'))
  const child = spawn(process.execPath, [SERVER_PATH, '--data-dir', dataDirectory], {
    stdio: ['pipe', 'pipe', 'inherit'],
    // An empty scratch repo: these tests must never touch the real checkout, Neon or systemd.
    env: { ...process.env, BOOKING_REPO: dataDirectory, WORKTREES_DIR: join(dataDirectory, 'wt') },
  })
  const pending = new Map()
  let nextId = 1
  let failure
  const failAll = (error) => {
    failure ??= error
    for (const waiter of pending.values()) waiter.reject(failure)
    pending.clear()
  }
  child.on('error', failAll)
  child.stdin.on('error', failAll)
  child.on('exit', (code, signal) => failAll(new Error('the server exited (' + (signal ?? code) + ')')))
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    const message = JSON.parse(line)
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  })
  t.after(async () => {
    child.stdin.end()
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    rmSync(dataDirectory, { recursive: true, force: true })
  })
  return {
    request(method, params = {}) {
      if (failure) return Promise.reject(failure)
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(method + ' got no answer within ' + REQUEST_TIMEOUT_MS + 'ms'))
        }, REQUEST_TIMEOUT_MS)
        pending.set(id, {
          resolve: (result) => {
            clearTimeout(timer)
            resolve(result)
          },
          reject: (error) => {
            clearTimeout(timer)
            reject(error)
          },
        })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    },
  }
}

async function connect(t) {
  const mcp = client(t)
  const initialized = await mcp.request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'worktrees-test', version: '1.0.0' },
  })
  assert.equal(initialized.serverInfo.name, 'worktrees')
  return mcp
}

test('exposes the worktree tools with typed schemas', async (t) => {
  const mcp = await connect(t)
  const { tools } = await mcp.request('tools/list')
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
  for (const name of [
    'list_worktrees', 'create_worktree', 'remove_worktree', 'set_worktree_phone', 'start_worktree', 'stop_worktree', 'open_worktrees',
    'chat_send', 'chat_messages', 'chat_onboard', 'chat_reset',
  ]) {
    assert.ok(byName[name], name + ' is listed')
    assert.equal(byName[name].inputSchema.type, 'object')
  }
  assert.deepEqual(byName.create_worktree.inputSchema.required, ['name'])
  assert.equal(byName.remove_worktree.annotations.destructiveHint, true)
  assert.equal(byName.list_worktrees.annotations.readOnlyHint, true)
  assert.ok(byName.list_worktrees.outputSchema.properties.worktrees)
  assert.deepEqual(byName.chat_send.inputSchema.required.sort(), ['name', 'phone', 'text'])
  assert.equal(byName.chat_reset.annotations.destructiveHint, true)
  assert.equal(byName.chat_messages.annotations.readOnlyHint, true)
})

test('lists an empty registry through the tool and the resource', async (t) => {
  const mcp = await connect(t)
  const listed = await mcp.request('tools/call', { name: 'list_worktrees', arguments: {} })
  assert.deepEqual(listed.structuredContent.worktrees, [])
  assert.match(listed.content[0].text, /No worktrees yet/)
  const read = await mcp.request('resources/read', { uri: 'atmos://worktrees/list' })
  assert.deepEqual(JSON.parse(read.contents[0].text).worktrees, [])
})

test('rejects bad names and phones before doing anything', async (t) => {
  const mcp = await connect(t)
  for (const args of [{ name: 'Bad Name' }, { name: 'x'.repeat(31) }, { name: 'ok', phone: '0151 123' }]) {
    const result = await mcp.request('tools/call', { name: 'create_worktree', arguments: args }).catch((err) => ({ isError: true, err }))
    assert.equal(result.isError, true, JSON.stringify(args) + ' is rejected')
  }
})

test('reports unknown worktrees as errors', async (t) => {
  const mcp = await connect(t)
  for (const [name, args] of [
    ['remove_worktree', { name: 'ghost' }],
    ['set_worktree_phone', { name: 'ghost', phone: '+4915112345678' }],
    ['start_worktree', { name: 'ghost' }],
    ['stop_worktree', { name: 'ghost' }],
    ['chat_send', { name: 'ghost', phone: '+15550100001', text: 'hi' }],
    ['chat_messages', { name: 'ghost', phone: '+15550100001' }],
    ['chat_reset', { name: 'ghost', phone: '+15550100001' }],
    ['chat_onboard', { name: 'ghost', phone: '+15550100001', city: 'Berlin', interests: [], monthlyBudgetEur: 100, autoApproveEur: 20 }],
  ]) {
    const result = await mcp.request('tools/call', { name, arguments: args }).catch((err) => ({ isError: true, content: [{ text: err.message }] }))
    assert.equal(result.isError, true, name + ' fails')
    assert.match(result.content[0].text, /No worktree named "ghost"/)
  }
})

test('serves the App document', async (t) => {
  const mcp = await connect(t)
  const { tools } = await mcp.request('tools/list')
  const open = tools.find((tool) => tool.name === 'open_worktrees')
  assert.equal(open._meta.ui.resourceUri, 'ui://worktrees/app.html')
  const resource = await mcp.request('resources/read', { uri: 'ui://worktrees/app.html' })
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app')
  assert.match(resource.contents[0].text, /createRoot|StrictMode|atmos/)
  const opened = await mcp.request('tools/call', { name: 'open_worktrees', arguments: {} })
  assert.deepEqual(opened.structuredContent, { ready: true })
})
