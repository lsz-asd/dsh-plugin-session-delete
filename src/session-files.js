// dsh-chameleon session-delete: per-session file artifact cleanup (host half).
//
// "Files newly produced in a session" = uploads the user dropped into that
// session (`<cwd>/.dsh-uploads/<sessionId>/`) plus files the agent created
// in the session's workspace. To know what "created" means without rewriting
// the harness fs layer, this module keeps a one-shot baseline ledger:
//
//   - at `session/created` the plugin snapshots the session workspace
//     (relative path + mtime + size per file, skipping huge generated
//     directories); the ledger is stored under
//     <DSH_HOME>/plugin-data/chameleon-session-delete/ledgers/<rawId>.json
//   - at session delete the current tree is diffed against the baseline:
//       * files absent from the baseline  -> created by the session
//       * files present but modified      -> pre-existing, KEPT
//       * directories absent from the baseline tree that ended up empty
//                                         -> prunable
//   - without a ledger (plugin installed after the session, snapshot
//     truncated, workspace moved) the fallback attributes only files whose
//     filesystem creation/birth time is at/after the session creation time
//     (birth-time semantics: merely-modified pre-existing files survive)
//
// Deletion itself is CONFIRMATION-GATED in two phases:
//
//   1. `previewSessionWorkspaces` collects the produced-file list WITHOUT
//      touching anything; the caller (HTTP delete endpoint) freezes it into
//      a pending record under
//      <DSH_HOME>/plugin-data/chameleon-session-delete/pending/<rawId>.json
//      and the client renders it as a checkable list.
//   2. `applyPendingSelection` runs only after the user confirms: it removes
//      exactly the selected items and prunes newly-empty directories. A
//      record that is never confirmed simply keeps the files; stale records
//      (30+ days) are swept at plugin startup — metadata only, files stay.
//
// The `workbench_session_delete` tool cannot ask a human, so its path
// (`cleanupSessionFiles` / `cleanupSessionWorkspaces`) stays automatic:
// diff and delete everything the session produced in one pass.
//
// Nothing outside the workspace is ever touched; symlinks are recorded and
// removed as links only (targets are never followed or deleted). The
// snapshot is capped so a giant workspace degrades to the fallback instead
// of unbounded scanning. All per-file failures are reported, never fatal:
// deleting the session must not be blocked by a locked file.
//
// This module has no harness dependencies (node:fs only) so the diff logic
// is directly unit-testable.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

export const LEDGER_VERSION = 1
export const PENDING_VERSION = 1

// Directories skipped during the baseline snapshot (and the delete-time
// walk, so both sides stay symmetric). Generated/vendor trees can be huge;
// files created inside them will simply not be attributed to the session.
// Override via DSH_SESSION_DELETE_SKIP_DIRS (',' or ';' separated; an empty
// value disables skipping entirely).
const DEFAULT_SKIP_DIRS = [
  '.git', '.hg', '.svn',
  'node_modules',
  '.venv', 'venv', '__pycache__',
  '.next', '.nuxt', '.output',
  'target',
  '.dsh', '.dsh-uploads', // harness internals; .dsh-uploads is cleaned per-session
]

// Cap on snapshot entries; beyond it the snapshot is abandoned and the
// delete path falls back to birth-time + upload-dir cleanup. Override via
// DSH_SESSION_DELETE_MAX_ENTRIES.
const DEFAULT_MAX_SNAPSHOT_ENTRIES = 200000

// Report samples are capped so a huge failing set cannot balloon responses.
const MAX_REPORT_ITEMS = 50

// Grace (ms) on the birth-time fallback: absorbs clock granularity between
// the session-header timestamp and filesystem timestamps. Kept tight so a
// pre-existing file created a moment before the session started is not
// misattributed to the session.
const BIRTHTIME_GRACE_MS = 250

// A pending record that was never confirmed is dropped (metadata only —
// the files on disk are never touched by the sweep) after this age.
const PENDING_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function rawSessionId(sessionId) {
  return String(sessionId || '').replace(/^session-/i, '')
}

export function ledgerRoot() {
  return path.join(dshHome(), 'plugin-data', 'chameleon-session-delete', 'ledgers')
}

export function ledgerPathFor(sessionId) {
  return path.join(ledgerRoot(), `${rawSessionId(sessionId)}.json`)
}

export function pendingRoot() {
  return path.join(dshHome(), 'plugin-data', 'chameleon-session-delete', 'pending')
}

export function pendingPathFor(sessionId) {
  return path.join(pendingRoot(), `${rawSessionId(sessionId)}.json`)
}

export function readLedger(sessionId) {
  const file = ledgerPathFor(sessionId)
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  try {
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object' || data.version !== LEDGER_VERSION) return null
    if (typeof data.workspacePath !== 'string' || !data.files || typeof data.files !== 'object') return null
    return data
  } catch {
    return null
  }
}

function removeLedger(sessionId) {
  try {
    fs.rmSync(ledgerPathFor(sessionId), { force: true })
  } catch { /* best effort */ }
}

export async function writeLedger(sessionId, { workspacePath, createdAt, derived }, snapshot) {
  const file = ledgerPathFor(sessionId)
  const files = {}
  for (const [rel, rec] of (snapshot ? snapshot.entries : [])) {
    files[rel] = rec.symlink ? [rec.mtimeMs, 0, 1] : [rec.mtimeMs, rec.size]
  }
  const payload = {
    version: LEDGER_VERSION,
    sessionId: rawSessionId(sessionId),
    workspacePath,
    createdAt: Number(createdAt) || null,
    snapshottedAt: Date.now(),
    // `derived: true` marks a fork/subagent session: it shares its parent's
    // workspace, so NO baseline is recorded and deletion must not scan the
    // workspace either (files the parent created after the fork would be
    // misattributed). Only the session upload dir is cleaned.
    ...(derived ? { derived: true } : {}),
    files,
  }
  return atomicWriteJson(file, payload)
}

// --- pending record (the frozen produced-file list awaiting confirmation) ---

export function readPending(sessionId) {
  const file = pendingPathFor(sessionId)
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  try {
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object' || data.version !== PENDING_VERSION) return null
    if (!Array.isArray(data.items) || !Array.isArray(data.workspaces)) return null
    return data
  } catch {
    return null
  }
}

export function writePending(sessionId, preview) {
  const payload = {
    version: PENDING_VERSION,
    sessionId: rawSessionId(sessionId),
    savedAt: Date.now(),
    mode: preview.mode || 'multi',
    workspaces: preview.workspaces || [],
    items: preview.items || [],
    newDirs: preview.newDirs || [],
    modifiedCount: preview.modifiedCount || 0,
    modifiedKept: (preview.modifiedKept || []).slice(0, MAX_REPORT_ITEMS),
  }
  return atomicWriteJson(pendingPathFor(sessionId), payload)
}

function removePending(sessionId) {
  try {
    fs.rmSync(pendingPathFor(sessionId), { force: true })
  } catch { /* best effort */ }
}

// Drop never-confirmed pending records older than `maxAgeMs`. This removes
// METADATA only — the files on disk are always left alone (keeping them was
// a valid user choice). Returns how many records were dropped.
export function sweepStalePending(maxAgeMs = PENDING_MAX_AGE_MS) {
  let names
  try {
    names = fs.readdirSync(pendingRoot())
  } catch {
    return 0
  }
  const cutoff = Date.now() - maxAgeMs
  let removed = 0
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const full = path.join(pendingRoot(), name)
    try {
      const st = fs.statSync(full)
      if (st.mtimeMs < cutoff) {
        fs.rmSync(full, { force: true })
        removed += 1
      }
    } catch { /* unreadable: skip */ }
  }
  return removed
}

function atomicWriteJson(file, payload) {
  let tmp = ''
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    if (tmp) {
      try { fs.rmSync(tmp, { force: true }) } catch { /* best effort */ }
    }
    return false
  }
}

function resolveSkipDirs() {
  if (Object.prototype.hasOwnProperty.call(process.env, 'DSH_SESSION_DELETE_SKIP_DIRS')) {
    return new Set(String(process.env.DSH_SESSION_DELETE_SKIP_DIRS).split(/[,;]/).map((s) => s.trim()).filter(Boolean))
  }
  return new Set(DEFAULT_SKIP_DIRS)
}

function maxSnapshotEntries() {
  const raw = process.env.DSH_SESSION_DELETE_MAX_ENTRIES
  if (raw && /^\d+$/.test(String(raw).trim())) {
    return Math.max(1, Number(String(raw).trim()))
  }
  return DEFAULT_MAX_SNAPSHOT_ENTRIES
}

// Snapshot every regular file (and symlink entry — records the LINK only)
// below `root`, deterministically ordered, skipping configured directories.
// Returns { entries: Map<relPath, {mtimeMs, size, symlink}>, truncated }.
export async function snapshotWorkspace(root) {
  const entries = new Map()
  const skip = resolveSkipDirs()
  const cap = maxSnapshotEntries()
  let truncated = false

  const walk = async (abs, rel) => {
    if (entries.size >= cap) {
      truncated = true
      return
    }
    let dirents
    try {
      dirents = await fs.promises.readdir(abs, { withFileTypes: true })
    } catch {
      return // unreadable subtree: leave it out of the baseline
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const dirent of dirents) {
      if (entries.size >= cap) {
        truncated = true
        return
      }
      try {
        if (dirent.isDirectory()) {
          if (skip.has(dirent.name)) continue
          await walk(path.join(abs, dirent.name), rel ? `${rel}/${dirent.name}` : dirent.name)
        } else if (dirent.isSymbolicLink() || dirent.isFile()) {
          const st = await fs.promises.lstat(path.join(abs, dirent.name))
          const childRel = rel ? `${rel}/${dirent.name}` : dirent.name
          entries.set(childRel, {
            mtimeMs: st.mtimeMs,
            size: st.size,
            symlink: dirent.isSymbolicLink(),
          })
        }
      } catch { /* entry vanished mid-walk: skip */ }
    }
  }

  await walk(root, '')
  return { entries, truncated }
}

// Ensure a candidate absolute path stays inside the workspace root.
function insideRoot(root, candidate) {
  const r = path.resolve(root)
  const c = path.resolve(candidate)
  if (c === r) return true
  return c.startsWith(r + path.sep)
}

async function isDir(p) {
  try {
    return (await fs.promises.stat(p)).isDirectory()
  } catch {
    return false
  }
}

// Best-effort recursive size of a directory (for the checkable list UI),
// capped like the snapshot so a pathological tree cannot stall the preview.
async function dirSize(root) {
  let total = 0
  let counted = 0
  const cap = maxSnapshotEntries()
  const walk = async (abs) => {
    let dirents
    try {
      dirents = await fs.promises.readdir(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const dirent of dirents) {
      if (counted >= cap) return
      const child = path.join(abs, dirent.name)
      try {
        if (dirent.isDirectory()) {
          await walk(child)
        } else {
          const st = await fs.promises.lstat(child)
          total += st.size || 0
          counted += 1
        }
      } catch { /* vanished: skip */ }
    }
  }
  await walk(root)
  return total
}

// The session upload dirs `<ws>/.dsh-uploads/<sessionId>/` (both id
// spellings) as checkable list items.
async function collectUploadDirItems(workspacePath, uploadDirs) {
  const items = []
  for (const dir of uploadDirs || []) {
    if (!insideRoot(workspacePath, dir)) continue
    if (!(await isDir(dir))) continue
    items.push({
      kind: 'uploadDir',
      rel: path.relative(workspacePath, dir).split(path.sep).join('/'),
      abs: dir,
      size: await dirSize(dir),
    })
  }
  return items
}

// Non-destructive diff of ONE workspace against its ledger (or the
// birth-time fallback): what the session produced here, without deleting
// anything. Returns:
//   { mode: 'ledger'|'fallback'|'derived'|'uploads'|'none',
//     files: [{ rel, abs, size, symlink }],          // session-created files
//     newDirs: [rel...] | null,                        // prunable-if-empty dirs (ledger mode)
//     modifiedCount, modifiedKept }                    // pre-existing files the session touched
async function collectWorkspaceDiff({ workspacePath, ledger, createdAt }) {
  const out = { mode: 'none', files: [], newDirs: null, modifiedCount: 0, modifiedKept: [] }
  if (!workspacePath || !path.isAbsolute(workspacePath) || !(await isDir(workspacePath))) {
    return out
  }

  // A derived ledger (fork/subagent) suppresses BOTH the baseline diff and
  // the birth-time fallback: the workspace is shared with the parent, so
  // scanning it would misattribute the parent's post-fork files.
  const derivedLedger = ledger && ledger.derived ? ledger : null
  const usableLedger = ledger && !ledger.derived && !ledger.truncated && ledger.workspacePath === path.resolve(workspacePath) ? ledger : null
  const fallbackCreatedAt = usableLedger || derivedLedger ? null : createdAt
  out.mode = usableLedger ? 'ledger' : derivedLedger ? 'derived' : fallbackCreatedAt ? 'fallback' : 'uploads'
  if (out.mode !== 'ledger' && out.mode !== 'fallback') return out

  // baseline lookup: relPath -> {mtimeMs, size, symlink}
  let baseline = null
  if (usableLedger) {
    baseline = new Map()
    for (const [rel, arr] of Object.entries(usableLedger.files)) {
      baseline.set(rel, { mtimeMs: arr[0], size: arr[1] || 0, symlink: arr[2] === 1 })
    }
  }

  // Baseline-known directory prefixes (ledger mode only): a directory that
  // was an ancestor of any baseline file is pre-existing and may not be
  // pruned even when empty.
  let baselineDirs = null
  if (baseline) {
    baselineDirs = new Set([''])
    for (const rel of baseline.keys()) {
      const parts = rel.split('/')
      for (let i = 1; i < parts.length; i++) baselineDirs.add(parts.slice(0, i).join('/'))
    }
  }

  const skip = resolveSkipDirs()
  const dirsSeen = []

  const walk = async (abs, rel) => {
    let dirents
    try {
      dirents = await fs.promises.readdir(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const dirent of dirents) {
      const childAbs = path.join(abs, dirent.name)
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name
      try {
        if (dirent.isDirectory()) {
          if (skip.has(dirent.name)) continue
          dirsSeen.push({ rel: childRel, abs: childAbs })
          await walk(childAbs, childRel)
        } else if (dirent.isSymbolicLink() || dirent.isFile()) {
          const st = await fs.promises.lstat(childAbs)
          if (baseline) {
            const b = baseline.get(childRel)
            if (!b) {
              // New since the baseline -> session-produced.
              out.files.push({
                rel: childRel,
                abs: childAbs,
                size: st.isSymbolicLink() ? 0 : (st.size || 0),
                symlink: st.isSymbolicLink(),
              })
            } else if (b.mtimeMs !== st.mtimeMs || b.size !== st.size) {
              out.modifiedCount += 1
              if (out.modifiedKept.length < MAX_REPORT_ITEMS) out.modifiedKept.push(childRel)
            }
          } else if (fallbackCreatedAt) {
            // Fallback: a file counts as produced only when BORN at/after
            // the session start AND touched (mtime) at/after it — a
            // recreated pre-existing file (writeFile CREATE_ALWAYS resets
            // the birth time on Windows) only counts when the session also
            // rewrote it. A file whose birth time is unavailable is kept.
            const born = st.birthtimeMs
            if (born > 0 && born >= fallbackCreatedAt - BIRTHTIME_GRACE_MS &&
                st.mtimeMs >= fallbackCreatedAt - BIRTHTIME_GRACE_MS) {
              out.files.push({
                rel: childRel,
                abs: childAbs,
                size: st.isSymbolicLink() ? 0 : (st.size || 0),
                symlink: st.isSymbolicLink(),
              })
            } else {
              out.modifiedCount += 1
              if (out.modifiedKept.length < MAX_REPORT_ITEMS) out.modifiedKept.push(childRel)
            }
          } // no createdAt: files stay untouched (upload dirs only)
        }
      } catch { /* vanished/racy entry: skip */ }
    }
  }

  await walk(workspacePath, '')

  // Directories created during the session (ledger mode only): candidates
  // for pruning once they are (or become) empty.
  if (baseline && baselineDirs) {
    out.newDirs = dirsSeen
      .filter((d) => d.rel !== '' && !baselineDirs.has(d.rel))
      .map((d) => d.rel)
  }

  return out
}

// Execute the removal of a filtered item list in ONE workspace. `items`:
// [{kind: 'file'|'uploadDir', rel, abs, size}] — files/symlinks are removed
// as single entries (never followed), upload dirs recursively. `newDirs`
// (ledger mode) are pruned when empty, deepest first. Best-effort: every
// failure is recorded on `report`, nothing throws.
async function removeItems({ workspacePath, items, newDirs, report }) {
  if (!Array.isArray(items)) return
  let removedUploadDir = false

  for (const item of items) {
    if (!item || typeof item.abs !== 'string') continue
    if (!insideRoot(workspacePath, item.abs)) continue
    const rel = typeof item.rel === 'string' && item.rel ? item.rel : path.relative(workspacePath, item.abs)
    if (item.kind === 'uploadDir') {
      if (!(await isDir(item.abs))) continue
      try {
        await fs.promises.rm(item.abs, { recursive: true, force: true })
        report.uploadDirsRemoved += 1
        removedUploadDir = true
      } catch (e) {
        report.failed += 1
        if (report.failures.length < MAX_REPORT_ITEMS) {
          report.failures.push(`${rel}: ${e && e.code ? e.code : e && e.message ? e.message : String(e)}`)
        }
      }
    } else {
      try {
        await fs.promises.rm(item.abs, { force: true })
        report.removed += 1
        report.bytes += item.size || 0
      } catch (e) {
        report.failed += 1
        if (report.failures.length < MAX_REPORT_ITEMS) {
          report.failures.push(`${rel}: ${e && e.code ? e.code : e && e.message ? e.message : String(e)}`)
        }
      }
    }
  }

  // Prune the `.dsh-uploads` parent once a session upload dir was removed
  // and nothing else remains inside.
  if (removedUploadDir) {
    const parent = path.join(workspacePath, '.dsh-uploads')
    if (await isDir(parent)) {
      try {
        const rest = await fs.promises.readdir(parent)
        if (rest.length === 0) {
          await fs.promises.rm(parent, { recursive: true, force: true })
        }
      } catch { /* keep the dir on any error */ }
    }
  }

  // Prune session-created directories that are now empty, deepest first.
  // A dir that still holds an unselected (kept) file is not empty and is
  // naturally skipped by the readdir check.
  if (Array.isArray(newDirs) && newDirs.length > 0) {
    const ordered = newDirs.slice().sort((a, b) => b.length - a.length)
    for (const rel of ordered) {
      const abs = path.join(workspacePath, rel)
      if (!insideRoot(workspacePath, abs)) continue
      try {
        const rest = await fs.promises.readdir(abs)
        if (rest.length === 0) {
          // `recursive` is required on Windows even for an empty directory
          // (EISDIR otherwise); safe: the dir is confirmed empty above.
          await fs.promises.rm(abs, { recursive: true, force: true })
          report.prunedDirs += 1
        }
      } catch { /* not empty / gone / locked: keep */ }
    }
  }
}

function baseReport(mode) {
  return {
    mode,
    removed: 0,
    bytes: 0,
    failed: 0,
    failures: [],
    prunedDirs: 0,
    uploadDirsRemoved: 0,
    modifiedCount: 0,
    modifiedKept: [],
  }
}

// AUTOMATIC mode (the workbench_session_delete tool has no human to ask):
// diff and delete everything the session produced in ONE workspace, in one
// pass. Same signature/report as v0.4.0.
export async function cleanupSessionFiles({ sessionId, workspacePath, ledger, createdAt, uploadDirs }) {
  const report = baseReport('none')

  if (sessionId) removeLedger(sessionId) // the session is going away either way

  const diff = await collectWorkspaceDiff({ workspacePath, ledger, createdAt })
  report.mode = diff.mode
  report.modifiedCount = diff.modifiedCount
  report.modifiedKept = diff.modifiedKept
  if (diff.mode === 'none') return report

  const uploadItems = await collectUploadDirItems(workspacePath, uploadDirs || [])
  const items = [
    ...uploadItems,
    ...diff.files.map((f) => ({ kind: 'file', ...f })),
  ]
  await removeItems({ workspacePath, items, newDirs: diff.newDirs, report })
  return report
}

// Aggregate helper: run the automatic cleanup across several workspaces.
export async function cleanupSessionWorkspaces({ sessionId, targets, createdAt }) {
  const reports = []
  for (const target of targets) {
    reports.push(await cleanupSessionFiles({
      sessionId,
      workspacePath: target.workspacePath,
      ledger: target.ledger || null,
      createdAt,
      uploadDirs: target.uploadDirs || [],
    }))
  }
  return mergeReports(reports)
}

function mergeReports(reports) {
  const merged = {
    targets: reports.length,
    mode: reports.length === 1 ? reports[0].mode : 'multi',
    removed: 0,
    bytes: 0,
    failed: 0,
    failures: [],
    prunedDirs: 0,
    uploadDirsRemoved: 0,
    modifiedCount: 0,
    modifiedKept: [],
    per: reports,
  }
  for (const r of reports) {
    merged.removed += r.removed
    merged.bytes += r.bytes
    merged.failed += r.failed
    merged.prunedDirs += r.prunedDirs
    merged.uploadDirsRemoved += r.uploadDirsRemoved
    merged.modifiedCount += r.modifiedCount
    for (const f of r.failures) if (merged.failures.length < MAX_REPORT_ITEMS) merged.failures.push(f)
    for (const m of r.modifiedKept) if (merged.modifiedKept.length < MAX_REPORT_ITEMS) merged.modifiedKept.push(m)
  }
  return merged
}

// INTERACTIVE mode, phase 1: collect the produced-file list across the
// session's workspace targets WITHOUT deleting anything. Every entry gets a
// stable unique `key` so a later apply can select by key. The caller freezes
// the result via writePending() and drops the ledger (the frozen record
// supersedes it).
export async function previewSessionWorkspaces({ sessionId, targets, createdAt }) {
  const items = []
  const workspaces = []
  const newDirs = []
  const modes = []
  let modifiedCount = 0
  const modifiedKept = []
  let key = 0

  for (const target of targets || []) {
    const wsPath = target.workspacePath
    if (!wsPath || !path.isAbsolute(wsPath)) continue
    const diff = await collectWorkspaceDiff({ workspacePath: wsPath, ledger: target.ledger || null, createdAt })
    const uploadItems = await collectUploadDirItems(wsPath, target.uploadDirs || [])
    for (const item of uploadItems) {
      items.push({ key: String(key++), workspacePath: wsPath, ...item })
    }
    for (const f of diff.files) {
      items.push({ key: String(key++), workspacePath: wsPath, kind: 'file', ...f })
    }
    workspaces.push(wsPath)
    modes.push(diff.mode)
    if (diff.newDirs && diff.newDirs.length > 0) {
      newDirs.push({ workspacePath: wsPath, dirs: diff.newDirs })
    }
    modifiedCount += diff.modifiedCount
    for (const m of diff.modifiedKept) if (modifiedKept.length < MAX_REPORT_ITEMS) modifiedKept.push(m)
  }

  return {
    targets: modes.length,
    mode: modes.length === 1 ? modes[0] : 'multi',
    items,
    workspaces,
    newDirs,
    modifiedCount,
    modifiedKept,
  }
}

// INTERACTIVE mode, phase 2: run ONLY the user-confirmed selection against
// the frozen pending record. `selectedKeys` is the array of item keys to
// remove (empty/absent = keep everything, which still clears the record).
// Returns the usual report, or null when no pending record exists (e.g.
// already applied, or the session had produced nothing).
export async function applyPendingSelection(sessionId, selectedKeys) {
  const pending = readPending(sessionId)
  if (!pending) return null

  const report = baseReport(pending.mode || 'multi')
  report.modifiedCount = pending.modifiedCount || 0
  report.modifiedKept = (pending.modifiedKept || []).slice(0, MAX_REPORT_ITEMS)

  const selected = new Set((Array.isArray(selectedKeys) ? selectedKeys : []).map(String))
  const byWorkspace = new Map()
  for (const item of pending.items || []) {
    if (!item || typeof item !== 'object') continue
    if (item.key === undefined || !selected.has(String(item.key))) continue
    const ws = item.workspacePath
    if (typeof ws !== 'string' || !ws) continue
    if (!byWorkspace.has(ws)) byWorkspace.set(ws, [])
    byWorkspace.get(ws).push(item)
  }

  for (const [ws, wsItems] of byWorkspace) {
    const dirs = []
    for (const n of pending.newDirs || []) {
      if (n && n.workspacePath === ws && Array.isArray(n.dirs)) dirs.push(...n.dirs)
    }
    await removeItems({ workspacePath: ws, items: wsItems, newDirs: dirs, report })
  }

  removePending(sessionId)
  return report
}

export { removeLedger, removePending }
