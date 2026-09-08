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
//       * files absent from the baseline  -> created by the session -> DELETED
//       * files present but modified      -> KEPT, reported
//       * directories absent from the baseline tree that ended up empty
//                                         -> pruned
//   - without a ledger (plugin installed after the session, snapshot
//     truncated, workspace moved) the fallback deletes only files whose
//     filesystem creation/birth time is at/after the session creation time
//     (birth-time semantics: merely-modified pre-existing files survive) —
//     and the session upload dirs are ALWAYS removed
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

// Delete one file (or symlink — never follows it). Returns {ok, error}.
async function deleteOne(abs, rel, report) {
  try {
    await fs.promises.rm(abs, { force: true })
    report.removed += 1
    return true
  } catch (e) {
    report.failed += 1
    if (report.failures.length < MAX_REPORT_ITEMS) {
      report.failures.push(`${rel}: ${e && e.code ? e.code : e && e.message ? e.message : String(e)}`)
    }
    return false
  }
}

// Remove the session upload dirs `<ws>/.dsh-uploads/<sessionId>/` (both id
// spellings) and prune the `.dsh-uploads` parent when it becomes empty.
async function removeUploadDirs(workspacePath, uploadDirs, report) {
  for (const dir of uploadDirs) {
    if (!insideRoot(workspacePath, dir)) continue
    if (!(await isDir(dir))) continue
    try {
      await fs.promises.rm(dir, { recursive: true, force: true })
      report.uploadDirsRemoved += 1
    } catch (e) {
      report.failed += 1
      if (report.failures.length < MAX_REPORT_ITEMS) {
        report.failures.push(`${path.relative(workspacePath, dir)}: ${e && e.code ? e.code : e && e.message ? e.message : String(e)}`)
      }
    }
  }
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

// Core cleanup for ONE workspace. `ledger` must be the ledger whose
// workspacePath matches (or null); `createdAt` (ms, nullable) powers the
// birth-time fallback; `uploadDirs` are the absolute session upload dirs
// under this workspace. Never throws; always returns a report.
export async function cleanupSessionFiles({ sessionId, workspacePath, ledger, createdAt, uploadDirs }) {
  const report = {
    mode: 'none',
    removed: 0,
    bytes: 0,
    failed: 0,
    failures: [],
    prunedDirs: 0,
    uploadDirsRemoved: 0,
    modifiedCount: 0,
    modifiedKept: [],
  }

  if (sessionId) removeLedger(sessionId) // the session is going away either way

  if (!workspacePath || !path.isAbsolute(workspacePath) || !(await isDir(workspacePath))) {
    return report
  }

  await removeUploadDirs(workspacePath, uploadDirs || [], report)

  // A derived ledger (fork/subagent) suppresses BOTH the baseline diff and
  // the birth-time fallback: the workspace is shared with the parent, so
  // scanning it would misattribute the parent's post-fork files.
  const derivedLedger = ledger && ledger.derived ? ledger : null
  const usableLedger = ledger && !ledger.derived && !ledger.truncated && ledger.workspacePath === path.resolve(workspacePath) ? ledger : null
  const fallbackCreatedAt = usableLedger || derivedLedger ? null : createdAt
  report.mode = usableLedger ? 'ledger' : derivedLedger ? 'derived' : fallbackCreatedAt ? 'fallback' : 'uploads'
  if (report.mode === 'none' || report.mode === 'uploads' || report.mode === 'derived') return report

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
              // New since the baseline -> session-produced -> delete.
              report.bytes += st.isSymbolicLink() ? 0 : (st.size || 0)
              await deleteOne(childAbs, childRel, report)
            } else if (b.mtimeMs !== st.mtimeMs || b.size !== st.size) {
              report.modifiedCount += 1
              if (report.modifiedKept.length < MAX_REPORT_ITEMS) report.modifiedKept.push(childRel)
            }
          } else if (fallbackCreatedAt) {
            // Fallback: delete only files BORN at/after the session start AND
            // touched (mtime) at/after it — a recreated pre-existing file
            // (writeFile CREATE_ALWAYS resets the birth time on Windows) is
            // only removed when the session also rewrote it. A file whose
            // birth time is unavailable is always kept.
            const born = st.birthtimeMs
            if (born > 0 && born >= fallbackCreatedAt - BIRTHTIME_GRACE_MS &&
                st.mtimeMs >= fallbackCreatedAt - BIRTHTIME_GRACE_MS) {
              report.bytes += st.isSymbolicLink() ? 0 : (st.size || 0)
              await deleteOne(childAbs, childRel, report)
            } else {
              report.modifiedCount += 1
              if (report.modifiedKept.length < MAX_REPORT_ITEMS) report.modifiedKept.push(childRel)
            }
          } // no createdAt: only upload dirs are handled, files stay untouched
        }
      } catch { /* vanished/racy entry: skip */ }
    }
  }

  await walk(workspacePath, '')

  // Prune directories created during the session that are now empty,
  // deepest first. Only ledger mode can know which dirs are new.
  if (baseline && baselineDirs) {
    const ordered = dirsSeen.slice().sort((a, b) => b.rel.length - a.rel.length)
    for (const dir of ordered) {
      if (!insideRoot(workspacePath, dir.abs)) continue
      if (dir.rel === '' || baselineDirs.has(dir.rel)) continue
      try {
        const rest = await fs.promises.readdir(dir.abs)
        if (rest.length === 0) {
          // `recursive` is required on Windows even for an empty directory
          // (EISDIR otherwise); safe: the dir is confirmed empty above.
          await fs.promises.rm(dir.abs, { recursive: true, force: true })
          report.prunedDirs += 1
        }
      } catch { /* not empty / gone / locked: keep */ }
    }
  }

  return report
}

// Aggregate helper: run cleanup across several workspace targets.
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

export { removeLedger }