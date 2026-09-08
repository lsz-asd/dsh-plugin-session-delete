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
//   2. flush a live session so dispose-time teardown has no pending writes;
//   3. remove the persisted log dir  ~/.dsh/sessions/<slug>/<id>/ for both id
//      spellings (raw uuid and `session-` prefixed);
//   4. drop the projection-cache row (storageDomain 'session_projcache',
//      table 'sessions');
//   5. auto-delete the files the session newly produced — its upload dir
//      (<cwd>/.dsh-uploads/<sessionId>/) plus workspace files created after
//      the session baseline ledger snapshot (birth-time fallback when no
//      ledger exists); pre-existing files the session modified are kept;
//   6. only after the log is confirmed gone, remove the workspace accounting
//      (domain 'workspace': sessionIds arrays + global.archivedSessionIds).
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
import {
  cleanupSessionWorkspaces,
  readLedger,
  snapshotWorkspace,
  writeLedger,
} from './session-files.js'

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

// Session ids may appear in two spellings in different stores: the raw id
// (`<uuid>`) and the prefixed form (`session-<uuid>`).  The on-disk JSONL
// backend encodes the exact session id, while older/workspace/projcache rows
// can carry either spelling.  Return every unique spelling we should clean up.
function sessionIdVariants(sessionId) {
  const variants = new Set([sessionId])
  if (sessionId.startsWith('session-')) {
    variants.add(sessionId.slice('session-'.length))
  } else if (SESSION_ID_RE.test(sessionId)) {
    variants.add(`session-${sessionId}`)
  }
  return [...variants]
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

// --- per-session file artifacts ----------------------------------------------
// "Files newly produced in the session" (uploads + workspace files created
// during the session) are cleaned by src/session-files.js. The host half is
// responsible for three things:
//   1. snapshotting the session workspace at `session/created` into a
//      baseline ledger (under <DSH_HOME>/plugin-data/chameleon-session-delete);
//   2. resolving, at delete time, every workspace path the session is
//      accounted in, plus the session creation time;
//   3. running the cleanup and reporting its outcome.

// Every workspace entity the session is accounted in (workspace domain
// records list sessionIds in display order). Returns unique absolute paths.
async function findSessionWorkspaces(ctx, sessionId) {
  const sd = ctx.get('storageDomain')
  if (!sd || typeof sd.get !== 'function') return []
  const ws = sd.get('workspace')
  if (!ws || typeof ws.table !== 'function') return []
  const variants = sessionIdVariants(sessionId)
  const out = []
  try {
    const workspaces = ws.table('workspaces')
    for (const [, rec] of workspaces.entries()) {
      if (!rec || typeof rec.path !== 'string') continue
      if (Array.isArray(rec.sessionIds) && variants.some((v) => rec.sessionIds.includes(v))) {
        if (!out.includes(rec.path)) out.push(rec.path)
      }
    }
  } catch { /* unit closed or table absent */ }
  return out
}

// The session creation time (ms) from the projection-cache identity, looked
// up BEFORE the projection rows are stripped.
function readProjectionCreatedAt(ctx, sessionId) {
  const sd = ctx.get('storageDomain')
  if (!sd || typeof sd.get !== 'function') return null
  const proj = sd.get('session_projcache')
  if (!proj || typeof proj.table !== 'function') return null
  try {
    const sessions = proj.table('sessions')
    for (const variant of sessionIdVariants(sessionId)) {
      const rec = sessions.get(variant)
      if (rec && rec.identity && typeof rec.identity.createdAt === 'number') {
        return rec.identity.createdAt
      }
    }
  } catch { /* unit closed or table absent */ }
  return null
}

// Snapshot the workspace of a newly created session into its baseline
// ledger, so deletion can later tell session-produced files apart from
// pre-existing ones. Background, fail-soft: a missing ledger merely falls
// back to birth-time heuristics at delete time. An existing ledger is never
// overwritten (re-announcing a session must not absorb its file history).
async function snapshotSessionArtifacts(ctx, session) {
  const sessionId = session && (session.id || (session.header && session.header.id))
  if (!sessionId || !SESSION_ID_RE.test(String(sessionId))) return
  const header = session.header
  if (!header || typeof header.cwd !== 'string') return
  const createdAt = typeof header.createdAt === 'number' ? header.createdAt : Date.now()
  if (readLedger(sessionId)) return
  try {
    const canonical = fs.realpathSync(header.cwd)
    if (!fs.statSync(canonical).isDirectory()) return
    // Derived sessions (subagents, forks) share the parent's workspace:
    // their writes are attributed to the parent's baseline, and deleting
    // them must NOT scan the shared workspace (files the parent created
    // after the fork would be misattributed). Record a derived marker —
    // on delete, only the session upload dir is cleaned.
    if (header.origin === 'subagent' || header.parentSession !== undefined) {
      await writeLedger(sessionId, { workspacePath: canonical, createdAt, derived: true }, null)
      return
    }
    const snap = await snapshotWorkspace(canonical)
    if (snap.truncated) return // too big: no baseline, fallback path applies
    await writeLedger(sessionId, { workspacePath: canonical, createdAt }, snap)
    ctx.logger && ctx.logger.debug && ctx.logger.debug(
      `session-delete: snapshotted workspace for ${sessionId} (${snap.entries.size} entries)`)
  } catch { /* workspace missing or snapshot failed: fallback at delete time */ }
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
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new DeleteError(`invalid session id: ${sessionId}`, 400)
  }
  const stopped = await stopAgentIfRunning(ctx, sessionId)
  await flushSessionIfLive(ctx, sessionId)
  const detached = detachLiveSession(ctx, sessionId)

  // Snapshot the session creation time BEFORE the projection rows are
  // stripped below (it powers the birth-time fallback for file cleanup).
  const createdAt = readProjectionCreatedAt(ctx, sessionId)

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

  // Auto-delete the files the session produced: its upload dirs
  // (<cwd>/.dsh-uploads/<sessionId>/) always; workspace files created during
  // the session per the baseline ledger (or birth-time fallback). Best-effort
  // by design: a locked file must not block the session deletion, and every
  // failure is reported in the result.
  const ledger = readLedger(sessionId)
  const wsPaths = await findSessionWorkspaces(ctx, sessionId)
  const targetSet = new Set()
  for (const p of wsPaths) targetSet.add(path.resolve(p))
  if (ledger && ledger.workspacePath) targetSet.add(path.resolve(ledger.workspacePath))
  const variants = sessionIdVariants(sessionId)
  const targets = []
  for (const wsPath of targetSet) {
    targets.push({
      workspacePath: wsPath,
      ledger: ledger && path.resolve(ledger.workspacePath) === wsPath ? ledger : null,
      uploadDirs: variants.map((v) => path.join(wsPath, '.dsh-uploads', v)),
    })
  }
  const files = await cleanupSessionWorkspaces({ sessionId, targets, createdAt })

  // Only after the log is confirmed gone do we detach the session from its
  // workspace/archive accounting.
  const workspaceStorage = await stripStorageDomains(ctx, sessionId, { workspace: true })
  const dirRemoved = firstDirRemoved || secondDirRemoved || thirdDirRemoved
  const projRemoved = projStorage.projRemoved || workspaceStorage.projRemoved
  const workspaceRemoved = workspaceStorage.workspaceRemoved
  if (!dirRemoved && !projRemoved && !workspaceRemoved &&
      files.removed === 0 && files.uploadDirsRemoved === 0 && files.failed === 0) {
    throw new DeleteError(`session not found: ${sessionId}`, 404)
  }
  return { stopped, detached, dirRemoved, projRemoved, workspaceRemoved, files }
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
    description: 'Permanently delete one session of this workbench: stops the agent if it is running (cancel + quiescence), then removes its persisted log, projection-cache row and workspace accounting. Also auto-deletes the files newly produced during that session (the session upload dir <.dsh-uploads/<sessionId>> and workspace files created after the session baseline snapshot; pre-existing files the session modified are kept). After deletion the client reloads; the edit-mode caller should verify with workbench_status or the session list.',
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
        const lines = [
          `deleted: ${sessionId}`,
          `log dir removed: ${result.dirRemoved}`,
          `projection row removed: ${result.projRemoved}`,
          `workspace accounting removed: ${result.workspaceRemoved}`,
          `session files removed: ${result.files.removed} files (${result.files.bytes} bytes) across ${result.files.targets} workspace(s)`,
          `session upload dirs removed: ${result.files.uploadDirsRemoved}`,
          `file removal failures: ${result.files.failed}`,
          `pre-existing files modified by the session kept: ${result.files.modifiedCount}`,
        ]
        if (result.files.failures && result.files.failures.length > 0) {
          lines.push(`failures: ${result.files.failures.slice(0, 5).join('; ')}`)
        }
        return lines.join('\n')
      } catch (e) {
        return `delete failed: ${e.message}`
      }
    },
  }))

  // Snapshot every new session's workspace into its baseline ledger so a
  // later delete can identify (and remove) the files the session produced.
  // Fail-soft: without a ledger the delete falls back to birth-time heuristics.
  if (typeof ctx.on === 'function') {
    ctx.on('session/created', (session) => {
      snapshotSessionArtifacts(ctx, session).catch((e) => {
        if (ctx.logger && typeof ctx.logger.warn === 'function') {
          ctx.logger.warn(`session-delete: file ledger snapshot failed: ${e && e.message ? e.message : String(e)}`)
        }
      })
    })
  }
}

export { apply, inject, name }
