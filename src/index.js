// dsh-chameleon workbench-session-delete: delete-session capability (Host half).
//
// Deletes one session end-to-end on the host:
//   POST /__chameleon/session/delete  - HTTP endpoint for the client button
//   workbench_session_delete          - model tool for edit mode
//
// Deletion steps, kept consistent with the LIVE storage services so the
// in-memory state and the on-disk units stay in sync (no "resurrected"
// session after the next periodic flush):
//   1. stop a live agent if one owns the session (ctx.agents.get(id), checked
//      for every id spelling via sessionIdVariants);
//   2. flush a live session so dispose-time teardown has no pending writes;
//   3. remove the persisted log dir  ~/.dsh/sessions/<slug>/<id>/ for both id
//      spellings (raw and `session-` prefixed);
//   4. drop the projection-cache row (storageDomain 'session_projcache',
//      table 'sessions');
//   5. only after the log is confirmed gone, remove the workspace accounting
//      (domain 'workspace': sessionIds arrays + global.archivedSessionIds).
//
// The client refreshes the session list in place after a successful delete (no
// page reload); the fresh list is re-fetched from the host (session-query reads
// the persisted dirs).
//
// ESM module format (cordis bundle rule): named exports apply/inject/name.
// All registrations belong to the plugin fiber (ctx.effect / disposers).
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isValidSessionId, sessionIdVariants } from './session-id.js'
import { parseJsonObjectBody } from './http-args.js'

const name = 'chameleon-session-delete'
// Only `tools` is a hard dependency; webServer is optional (see apply).
const inject = ['tools']

class DeleteError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

// --- path helpers ------------------------------------------------------------

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function sessionsRoot() {
  return path.join(dshHome(), 'sessions')
}

// Locate ~/.dsh/sessions/<slug>/<sessionId>/ by scanning every slug dir, so
// the workspace-path encoding never has to be re-derived here.  Returns every
// matching directory (both id spellings, if both exist).
function findSessionDirs(sessionId) {
  const root = sessionsRoot()
  const variants = sessionIdVariants(sessionId)
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    for (const variant of variants) {
      const candidate = path.join(root, e.name, variant)
      try {
        if (fs.statSync(candidate).isDirectory() && !found.includes(candidate)) found.push(candidate)
      } catch { /* keep scanning */ }
    }
  }
  return found
}

// Remove every on-disk session directory for both id spellings.
function removeSessionDirs(sessionId) {
  const dirs = findSessionDirs(sessionId)
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return dirs.length > 0
}

// --- live storage mutation (memory + disk stay consistent) -------------------

// Remove the session from the projection-cache domain and (optionally) the
// workspace accounting domain. Uses the opened domain facilities (the
// authoritative in-memory state) so the periodic flush can never re-publish a
// stale row.  All id spellings are cleaned because projcache/workspace rows
// may use either the raw uuid or the `session-` prefixed form.
// Domain API: storageDomain.get(name) -> domain with .table(name) (KvTable:
// get/put/delete/entries) and .global (handle with get/set).
async function stripStorageDomains(ctx, sessionId, { workspace = true } = {}) {
  const sd = ctx.get('storageDomain')
  if (!sd) return { projRemoved: false, workspaceRemoved: false }
  const variants = sessionIdVariants(sessionId)
  let projRemoved = false
  let workspaceRemoved = false

  const proj = sd.get('session_projcache')
  if (proj && typeof proj.table === 'function') {
    try {
      const sessions = proj.table('sessions')
      for (const variant of variants) {
        if (sessions.get(variant) !== undefined) {
          await sessions.delete(variant)
          projRemoved = true
        }
      }
    } catch { /* unit closed or table absent: nothing to clean */ }
  }

  if (workspace) {
    const ws = sd.get('workspace')
    if (ws && typeof ws.table === 'function') {
      try {
        const workspaces = ws.table('workspaces')
        for (const [wid, rec] of workspaces.entries()) {
          if (rec && Array.isArray(rec.sessionIds) && variants.some((v) => rec.sessionIds.includes(v))) {
            await workspaces.put(wid, {
              ...rec,
              sessionIds: rec.sessionIds.filter((x) => !variants.includes(x)),
            })
            workspaceRemoved = true
          }
        }
      } catch { /* unit closed or table absent */ }
      try {
        const g = ws.global
        if (g && typeof g.get === 'function' && typeof g.set === 'function') {
          const state = g.get()
          if (state && Array.isArray(state.archivedSessionIds) && variants.some((v) => state.archivedSessionIds.includes(v))) {
            await g.set({ ...state, archivedSessionIds: state.archivedSessionIds.filter((x) => !variants.includes(x)) })
            workspaceRemoved = true
          }
        }
      } catch { /* no global slot or unit closed */ }
    }
  }

  return { projRemoved, workspaceRemoved }
}

// --- core delete --------------------------------------------------------------

// Stop a live agent (cancel the active turn, wait for quiescence) before its
// session is deleted. Cancel causes surface in the log as a user-cancel; the
// wait is time-boxed so a stuck driver never blocks the deletion.
async function stopAgentIfRunning(ctx, sessionId) {
  const agents = ctx.get('agents')
  if (!agents || typeof agents.get !== 'function') return false
  let stopped = false
  for (const variant of sessionIdVariants(sessionId)) {
    const agent = agents.get(variant)
    if (!agent) continue
    stopped = true
    if (typeof agent.cancel === 'function') {
      try { agent.cancel({ kind: 'user' }) } catch { /* agent may already be settling */ }
    }
    if (typeof agent.whenIdle === 'function') {
      try {
        await Promise.race([
          agent.whenIdle(),
          new Promise((resolve) => setTimeout(resolve, 15000)),
        ])
      } catch { /* ignore: proceed with deletion anyway */ }
    }
  }
  return stopped
}

// Flush a live session before detaching it.  The persistence layer flushes on
// session/disposed; flushing here first drains any pending writes while the
// session is still alive, so the later dispose has nothing to re-create after
// we delete the on-disk log.
async function flushSessionIfLive(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions || typeof sessions.get !== 'function') return false
  let flushed = false
  for (const variant of sessionIdVariants(sessionId)) {
    const session = sessions.get(variant)
    if (!session) continue
    if (typeof sessions.flush === 'function') {
      try {
        await sessions.flush(session)
        flushed = true
      } catch { /* ignore: deletion proceeds and removes the log anyway */ }
    }
  }
  return flushed
}

// Remove the session from the in-memory store so host session lists stop
// returning it and no flush can re-materialize its files. The store has no
// public remove API; detachEntered is the store's own teardown path (deletes
// the entry and emits session/disposed). Try every id spelling defensively.
function detachLiveSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions) return false
  let detached = false
  try {
    const store = sessions.store
    for (const variant of sessionIdVariants(sessionId)) {
      const entry = store && typeof store.get === 'function' ? store.get(variant) : undefined
      if (entry === undefined) continue
      if (typeof sessions.detachEntered === 'function') {
        sessions.detachEntered(entry)
        detached = true
      } else if (store && typeof store.delete === 'function') {
        store.delete(variant)
        if (sessions.attachments && entry.session && typeof sessions.attachments.delete === 'function') {
          sessions.attachments.delete(entry.session)
        }
        detached = true
      }
    }
  } catch { /* ignore */ }
  return detached
}

async function deleteSessionCore(ctx, sessionId) {
  if (!isValidSessionId(sessionId)) {
    throw new DeleteError(`invalid session id: ${sessionId}`, 400)
  }
  const stopped = await stopAgentIfRunning(ctx, sessionId)
  await flushSessionIfLive(ctx, sessionId)
  const detached = detachLiveSession(ctx, sessionId)

  // Remove every on-disk log directory first.  If the filesystem refuses, fail
  // before touching workspace accounting so a half-deleted session cannot fall
  // out of its group into "Ungrouped".
  const firstDirRemoved = removeSessionDirs(sessionId)

  // Remove projection rows now (they are not the grouping authority), then
  // sweep again: the dispose path may have been mid-flight and could have
  // re-created a directory after the first removal.
  const projStorage = await stripStorageDomains(ctx, sessionId, { workspace: false })
  const secondDirRemoved = removeSessionDirs(sessionId)
  await new Promise((resolve) => setImmediate(resolve))
  const thirdDirRemoved = removeSessionDirs(sessionId)

  const remainingDirs = findSessionDirs(sessionId)
  if (remainingDirs.length > 0) {
    throw new DeleteError(`session files could not be fully removed: ${remainingDirs.join(', ')}`, 500)
  }

  // Only after the log is confirmed gone do we detach the session from its
  // workspace/archive accounting.
  const workspaceStorage = await stripStorageDomains(ctx, sessionId, { workspace: true })
  const dirRemoved = firstDirRemoved || secondDirRemoved || thirdDirRemoved
  const projRemoved = projStorage.projRemoved || workspaceStorage.projRemoved
  const workspaceRemoved = workspaceStorage.workspaceRemoved
  if (!dirRemoved && !projRemoved && !workspaceRemoved) {
    throw new DeleteError(`session not found: ${sessionId}`, 404)
  }
  return { stopped, detached, dirRemoved, projRemoved, workspaceRemoved }
}

// --- session list (diagnostics / compatibility) ------------------------------

// Lightweight {sessionId, title, running} list from the projection cache
// (authoritative titles) plus the live agent registry. The delete dialog no
// longer calls this endpoint: it fails closed when a row-level session id
// cannot be read, so no title-based deletion happens. The endpoint is kept
// for diagnostics and backward compatibility.
async function listSessions(ctx) {
  const agents = ctx.get('agents')
  const sd = ctx.get('storageDomain')
  const out = []
  if (!sd) return out
  const proj = sd.get('session_projcache')
  if (!proj || typeof proj.table !== 'function') return out
  try {
    const sessions = proj.table('sessions')
    for (const [id, rec] of sessions.entries()) {
      if (!rec || typeof rec !== 'object') continue
      const rows = rec.rows && typeof rec.rows === 'object' ? rec.rows : {}
      const titleRow = rows.title && rows.title.val
      const identity = rec.identity && typeof rec.identity === 'object' ? rec.identity : {}
      out.push({
        sessionId: id,
        title: typeof titleRow === 'string' ? titleRow : null,
        createdAt: typeof identity.createdAt === 'number' ? identity.createdAt : null,
        running: !!(agents && typeof agents.get === 'function' && agents.get(id)),
      })
    }
  } catch { /* unit closed or table absent */ }
  return out
}

// --- http helpers -------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (d) => {
      data += d
      if (data.length > 1e6) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}

// --- plugin -------------------------------------------------------------------
// webServer is OPTIONAL (a terminal-only profile has no web surface): the
// HTTP endpoint registers when the service exists or appears later
// (ctx.inject child), while the tool registers unconditionally — so the
// plugin never hangs waiting on a service a profile will never provide.

function apply(ctx) {
  function registerHttp(host, targetCtx) {
    targetCtx.effect(() => host.register({
      kind: 'exact',
      path: '/__chameleon/session/list',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        try {
          sendJson(res, 200, { ok: true, sessions: await listSessions(ctx) })
        } catch (e) {
          sendJson(res, 500, { error: e.message })
        }
      },
    }))

    targetCtx.effect(() => host.register({
      kind: 'exact',
      path: '/__chameleon/session/delete',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        let args = {}
        try {
          args = parseJsonObjectBody(await readBody(req))
        } catch {
          sendJson(res, 400, { error: 'bad json body' })
          return
        }
        const sessionId = String(args.sessionId || '').trim()
        if (!sessionId) {
          sendJson(res, 400, { error: 'sessionId required' })
          return
        }
        try {
          const result = await deleteSessionCore(ctx, sessionId)
          sendJson(res, 200, { ok: true, removed: [sessionId], ...result })
        } catch (e) {
          const status = e instanceof DeleteError && e.status ? e.status : 500
          sendJson(res, status, { error: e.message })
        }
      },
    }))
  }

  const ws = ctx.get('webServer')
  if (ws !== undefined) {
    registerHttp(ws, ctx)
  } else {
    // Register the route once a web surface appears (never in terminal-only
    // profiles); the child fiber is torn down with this plugin's context.
    ctx.inject(['webServer'], (sub) => {
      registerHttp(sub.webServer, sub)
    })
  }

  ctx.tools.register(defineTool({
    name: 'workbench_session_delete',
    description: 'Permanently delete one session of this workbench: stops the agent if it is running (cancel + quiescence), then removes its persisted log, projection-cache row and workspace accounting. After deletion the client reloads; the edit-mode caller should verify with workbench_status or the session list.',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: 'The session id to delete (uuid, session-<uuid>, custom id, or session-<custom id>).',
      },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: value }] },
    },
    async execute(args) {
      const sessionId = String(args.sessionId || '').trim()
      try {
        const result = await deleteSessionCore(ctx, sessionId)
        return [
          `deleted: ${sessionId}`,
          `log dir removed: ${result.dirRemoved}`,
          `projection row removed: ${result.projRemoved}`,
          `workspace accounting removed: ${result.workspaceRemoved}`,
        ].join('\n')
      } catch (e) {
        return `delete failed: ${e.message}`
      }
    },
  }))
}

export { apply, inject, name }
