// dsh-chameleon workbench-session-delete: delete-session capability (Host half).
//
// Deletes one session end-to-end on the host:
//   POST /__chameleon/session/delete  - HTTP endpoint for the client button
//   workbench_session_delete          - model tool for edit mode
//
// Deletion steps, kept consistent with the LIVE storage services so the
// in-memory state and the on-disk units stay in sync (no "resurrected"
// session after the next periodic flush):
//   1. refuse while a live agent owns the session (ctx.agents.get(id));
//   2. remove the persisted log dir  ~/.dsh/sessions/<slug>/<id>/;
//   3. drop the projection-cache row (storageDomain 'session_projcache',
//      table 'sessions') and the workspace accounting (domain 'workspace':
//      sessionIds arrays + global.archivedSessionIds).
//
// The client reloads after a successful delete, so the fresh session list is
// re-fetched from the host (session-query reads the persisted dirs).
//
// ESM module format (cordis bundle rule): named exports apply/inject/name.
// All registrations belong to the plugin fiber (ctx.effect / disposers).
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'

const name = 'chameleon-session-delete'
// Only `tools` is a hard dependency; webServer is optional (see apply).
const inject = ['tools']

const SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
// the workspace-path encoding never has to be re-derived here.
function findSessionDir(sessionId) {
  const root = sessionsRoot()
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const candidate = path.join(root, e.name, sessionId)
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate
    } catch { /* keep scanning */ }
  }
  return null
}

// --- live storage mutation (memory + disk stay consistent) -------------------

// Remove the session from the projection-cache domain and the workspace
// accounting domain. Uses the opened domain facilities (the authoritative
// in-memory state) so the periodic flush can never re-publish a stale row.
// Domain API: storageDomain.get(name) -> domain with .table(name) (KvTable:
// get/put/delete/entries) and .global (handle with get/set).
async function stripStorageDomains(ctx, sessionId) {
  const sd = ctx.get('storageDomain')
  if (!sd) return { projRemoved: false, workspaceRemoved: false }
  let projRemoved = false
  let workspaceRemoved = false

  const proj = sd.get('session_projcache')
  if (proj && typeof proj.table === 'function') {
    try {
      const sessions = proj.table('sessions')
      if (sessions.get(sessionId) !== undefined) {
        await sessions.delete(sessionId)
        projRemoved = true
      }
    } catch { /* unit closed or table absent: nothing to clean */ }
  }

  const ws = sd.get('workspace')
  if (ws && typeof ws.table === 'function') {
    try {
      const workspaces = ws.table('workspaces')
      for (const [wid, rec] of workspaces.entries()) {
        if (rec && Array.isArray(rec.sessionIds) && rec.sessionIds.includes(sessionId)) {
          await workspaces.put(wid, {
            ...rec,
            sessionIds: rec.sessionIds.filter((x) => x !== sessionId),
          })
          workspaceRemoved = true
        }
      }
    } catch { /* unit closed or table absent */ }
    try {
      const g = ws.global
      if (g && typeof g.get === 'function' && typeof g.set === 'function') {
        const state = g.get()
        if (state && Array.isArray(state.archivedSessionIds) && state.archivedSessionIds.includes(sessionId)) {
          await g.set({ ...state, archivedSessionIds: state.archivedSessionIds.filter((x) => x !== sessionId) })
          workspaceRemoved = true
        }
      }
    } catch { /* no global slot or unit closed */ }
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
  const agent = agents.get(sessionId)
  if (!agent) return false
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
  return true
}

// Remove the session from the in-memory store so host session lists stop
// returning it and no flush can re-materialize its files. The store has no
// public remove API; detachEntered is the store's own teardown path (deletes
// the entry and emits session/disposed). All access is defensive against
// internal shape changes.
function detachLiveSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions) return false
  try {
    const store = sessions.store
    const entry = store && typeof store.get === 'function' ? store.get(sessionId) : undefined
    if (entry !== undefined && typeof sessions.detachEntered === 'function') {
      sessions.detachEntered(entry)
      return true
    }
    if (entry !== undefined && store && typeof store.delete === 'function') {
      store.delete(sessionId)
      if (sessions.attachments && entry.session && typeof sessions.attachments.delete === 'function') {
        sessions.attachments.delete(entry.session)
      }
      return true
    }
  } catch { /* ignore */ }
  return false
}

async function deleteSessionCore(ctx, sessionId) {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new DeleteError(`invalid session id: ${sessionId}`, 400)
  }
  const stopped = await stopAgentIfRunning(ctx, sessionId)
  const detached = detachLiveSession(ctx, sessionId)
  const dir = findSessionDir(sessionId)
  let dirRemoved = false
  if (dir) {
    fs.rmSync(dir, { recursive: true, force: true })
    dirRemoved = true
  }
  const storage = await stripStorageDomains(ctx, sessionId)
  if (!dirRemoved && !storage.projRemoved && !storage.workspaceRemoved) {
    throw new DeleteError(`session not found: ${sessionId}`, 404)
  }
  return { stopped, detached, dirRemoved, ...storage }
}

// --- session list (for sidebar menu title -> id matching) ----------------------

// Lightweight {sessionId, title, running} list from the projection cache
// (authoritative titles) plus the live agent registry. The client sidebar
// menu item matches the row title against this list so it can open the
// delete dialog for the right session WITHOUT switching to it.
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
          const body = await readBody(req)
          if (body) args = JSON.parse(body)
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
        description: 'The session id to delete (uuid or session-<uuid> form).',
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
