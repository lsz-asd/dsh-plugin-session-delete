// Tests for the per-session file artifact cleanup (src/session-files.js).
// Pure node (node:test + builtins), no harness services required.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  cleanupSessionFiles,
  ledgerPathFor,
  rawSessionId,
  readLedger,
  snapshotWorkspace,
  writeLedger,
} from '../src/session-files.js'

const OLD_MTIME = new Date('2020-01-01T00:00:00Z')

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sd-test-'))
}

function w(abs, content) {
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

function age(abs) {
  fs.utimesSync(abs, OLD_MTIME, OLD_MTIME)
}

function exists(abs) {
  return fs.existsSync(abs)
}

function sid() {
  return randomUUID()
}

test('rawSessionId strips the session- prefix', () => {
  assert.equal(rawSessionId('session-abc'), 'abc')
  assert.equal(rawSessionId('abc'), 'abc')
})

test('ledger write/read roundtrip under DSH_HOME', async () => {
  const home = tmpRoot()
  const ws = path.join(home, 'ws')
  w(path.join(ws, 'a.txt'), 'a')
  process.env.DSH_HOME = home
  try {
    const id = sid()
    const snap = await snapshotWorkspace(ws)
    assert.equal(snap.truncated, false)
    assert.ok(await writeLedger(id, { workspacePath: ws, createdAt: 123 }, snap))
    const ledger = readLedger(id)
    assert.ok(ledger)
    assert.equal(ledger.workspacePath, ws)
    assert.equal(ledger.createdAt, 123)
    assert.ok(ledger.files['a.txt'])
    assert.equal(ledger.files['a.txt'][1], 1)
    assert.ok(exists(ledgerPathFor(id)))
    // session- prefixed lookup resolves to the same ledger
    assert.equal(readLedger(`session-${id}`).sessionId, id)
  } finally {
    delete process.env.DSH_HOME
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('ledger mode: deletes session-created files, keeps pre-existing ones', async () => {
  const ws = tmpRoot()
  const id = sid()
  try {
    // Pre-existing baseline.
    w(path.join(ws, 'old.txt'), 'old')
    w(path.join(ws, 'keep.txt'), 'keep')
    w(path.join(ws, 'dir1', 'sub.txt'), 'sub')
    age(path.join(ws, 'old.txt'))
    age(path.join(ws, 'keep.txt'))
    age(path.join(ws, 'dir1', 'sub.txt'))

    const snap = await snapshotWorkspace(ws)
    assert.ok(await writeLedger(id, { workspacePath: ws, createdAt: Date.now() }, snap))

    // What the session "produces".
    w(path.join(ws, 'new1.txt'), 'n1')
    w(path.join(ws, 'newdir', 'a.txt'), 'na')
    w(path.join(ws, 'newdir', 'sub', 'b.txt'), 'nb')
    const uploadRaw = path.join(ws, '.dsh-uploads', id)
    w(path.join(uploadRaw, 'doc.bin'), 'bin')
    // Session modifies a pre-existing file (new content + fresh mtime).
    w(path.join(ws, 'keep.txt'), 'keep-modified')
    const mod = new Date()
    fs.utimesSync(path.join(ws, 'keep.txt'), mod, mod)

    const report = await cleanupSessionFiles({
      sessionId: id,
      workspacePath: ws,
      ledger: readLedger(id),
      createdAt: Date.now(),
      uploadDirs: [uploadRaw, path.join(ws, '.dsh-uploads', `session-${id}`)],
    })

    assert.equal(report.mode, 'ledger')
    assert.equal(exists(path.join(ws, 'new1.txt')), false)
    assert.equal(exists(path.join(ws, 'newdir')), false, 'new empty dirs are pruned')
    assert.equal(exists(uploadRaw), false)
    assert.equal(report.uploadDirsRemoved, 1)
    if (exists(path.join(ws, '.dsh-uploads'))) {
      assert.equal(fs.readdirSync(path.join(ws, '.dsh-uploads')).length, 0)
    }
    // Pre-existing files survive; the modified one is kept and reported.
    assert.equal(exists(path.join(ws, 'old.txt')), true)
    assert.equal(exists(path.join(ws, 'dir1', 'sub.txt')), true)
    assert.equal(exists(path.join(ws, 'keep.txt')), true)
    assert.ok(report.modifiedCount >= 1)
    assert.ok(report.modifiedKept.includes('keep.txt'))
    assert.equal(report.failed, 0)
    assert.equal(report.removed, 3) // new1.txt + newdir/a.txt + newdir/sub/b.txt
    assert.equal(report.prunedDirs, 2) // newdir and newdir/sub
    assert.equal(readLedger(id), null, 'ledger is removed with the session')
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})

test('fallback mode (no ledger): birth-time heuristic removes only new files', async () => {
  const ws = tmpRoot()
  const id = sid()
  try {
    w(path.join(ws, 'old.txt'), 'old')
    w(path.join(ws, 'keep.txt'), 'keep')
    age(path.join(ws, 'old.txt'))
    age(path.join(ws, 'keep.txt'))
    // Wait well beyond the birth-time grace so pre-existing files are
    // conclusively older than the fake session start.
    await new Promise((r) => setTimeout(r, 600))

    const mod = new Date()
    const createdAt = Date.now()
    w(path.join(ws, 'new1.txt'), 'n1')
    w(path.join(ws, 'new2.log'), 'n2')
    // Modify a pre-existing file IN PLACE (r+): birthtime stays old, only
    // mtime moves — a rewrite that truncates (w) would reset the creation
    // time on Windows and rightly counts as "recreated by the session".
    const fh = fs.openSync(path.join(ws, 'keep.txt'), 'r+')
    fs.writeSync(fh, 'keep-modified')
    fs.closeSync(fh)
    fs.utimesSync(path.join(ws, 'keep.txt'), mod, mod)

    const report = await cleanupSessionFiles({
      sessionId: id,
      workspacePath: ws,
      ledger: null,
      createdAt,
      uploadDirs: [],
    })

    assert.equal(report.mode, 'fallback')
    assert.equal(exists(path.join(ws, 'new1.txt')), false)
    assert.equal(exists(path.join(ws, 'new2.log')), false)
    assert.equal(exists(path.join(ws, 'old.txt')), true)
    assert.equal(exists(path.join(ws, 'keep.txt')), true, 'modified pre-existing file keeps its old birthtime and survives')
    assert.equal(report.removed, 2)
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})

test('uploads-only mode: no ledger and no createdAt -> only upload dirs removed', async () => {
  const ws = tmpRoot()
  const id = sid()
  try {
    w(path.join(ws, 'whatever.txt'), 'x')
    const uploadRaw = path.join(ws, '.dsh-uploads', id)
    w(path.join(uploadRaw, 'doc.bin'), 'bin')
    const report = await cleanupSessionFiles({
      sessionId: id,
      workspacePath: ws,
      ledger: null,
      createdAt: null,
      uploadDirs: [uploadRaw],
    })
    assert.equal(report.mode, 'uploads')
    assert.equal(report.uploadDirsRemoved, 1)
    assert.equal(report.removed, 0)
    assert.equal(exists(path.join(ws, 'whatever.txt')), true)
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})

test('skip dirs and entry cap are honored by the snapshot', async () => {
  const ws = tmpRoot()
  try {
    const prevSkip = process.env.DSH_SESSION_DELETE_SKIP_DIRS
    process.env.DSH_SESSION_DELETE_SKIP_DIRS = 'node_modules,bigcache'
    try {
      w(path.join(ws, 'a.txt'), 'a')
      w(path.join(ws, 'node_modules', 'pkg', 'index.js'), 'x')
      w(path.join(ws, 'bigcache', 'blob'), 'x')
      const snap = await snapshotWorkspace(ws)
      assert.equal(snap.entries.has('a.txt'), true)
      assert.equal([...snap.entries.keys()].some((k) => k.startsWith('node_modules')), false)
      assert.equal([...snap.entries.keys()].some((k) => k.startsWith('bigcache')), false)
    } finally {
      if (prevSkip === undefined) delete process.env.DSH_SESSION_DELETE_SKIP_DIRS
      else process.env.DSH_SESSION_DELETE_SKIP_DIRS = prevSkip
    }

    const prevCap = process.env.DSH_SESSION_DELETE_MAX_ENTRIES
    process.env.DSH_SESSION_DELETE_MAX_ENTRIES = '3'
    try {
      w(path.join(ws, 'b.txt'), 'b')
      w(path.join(ws, 'c.txt'), 'c')
      w(path.join(ws, 'd.txt'), 'd')
      const capped = await snapshotWorkspace(ws)
      assert.equal(capped.truncated, true)
    } finally {
      if (prevCap === undefined) delete process.env.DSH_SESSION_DELETE_MAX_ENTRIES
      else process.env.DSH_SESSION_DELETE_MAX_ENTRIES = prevCap
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})

test('symlinks are recorded and removed as links only', async (t) => {
  const ws = tmpRoot()
  const id = sid()
  const target = path.join(ws, 'target.txt')
  const link = path.join(ws, 'link.txt')
  try {
    w(target, 'payload')
    fs.symlinkSync('target.txt', link) // may fail without privileges
  } catch {
    t.skip('symlink creation not permitted on this platform')
    return
  }
  try {
    const snap = await snapshotWorkspace(ws)
    assert.equal(snap.entries.get('link.txt').symlink, true)
    assert.ok(await writeLedger(id, { workspacePath: ws, createdAt: Date.now() }, snap))
    const report = await cleanupSessionFiles({
      sessionId: id,
      workspacePath: ws,
      ledger: readLedger(id),
      createdAt: Date.now(),
      uploadDirs: [],
    })
    assert.equal(report.mode, 'ledger')
    assert.equal(exists(link), false, 'the link itself is removed')
    assert.equal(exists(target), true, 'the link target is untouched')
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})

test('derived ledger (fork/subagent): only upload dirs cleaned, no workspace scan', async () => {
  const ws = tmpRoot()
  const id = sid()
  try {
    w(path.join(ws, 'pre-existing.txt'), 'x')
    const uploadRaw = path.join(ws, '.dsh-uploads', id)
    w(path.join(uploadRaw, 'doc.bin'), 'bin')
    // "Parent" creates a file after the fork point — it must survive the
    // derived session's deletion.
    w(path.join(ws, 'parent-created.txt'), 'p')

    const derivedLedger = {
      version: 1,
      sessionId: id,
      workspacePath: ws,
      createdAt: Date.now(),
      derived: true,
      files: {},
    }
    const report = await cleanupSessionFiles({
      sessionId: id,
      workspacePath: ws,
      ledger: derivedLedger,
      createdAt: Date.now(),
      uploadDirs: [uploadRaw],
    })

    assert.equal(report.mode, 'derived')
    assert.equal(report.uploadDirsRemoved, 1)
    assert.equal(report.removed, 0)
    assert.equal(exists(path.join(ws, 'pre-existing.txt')), true)
    assert.equal(exists(path.join(ws, 'parent-created.txt')), true)
    assert.equal(exists(uploadRaw), false)
    assert.equal(readLedger(id), null, 'derived marker is removed with the session')
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})

test('missing workspace: nothing happens, ledger still removed', async () => {
  const ws = tmpRoot()
  fs.rmSync(ws, { recursive: true, force: true })
  const id = sid()
  const report = await cleanupSessionFiles({
    sessionId: id,
    workspacePath: ws,
    ledger: null,
    createdAt: null,
    uploadDirs: [path.join(ws, '.dsh-uploads', id)],
  })
  assert.equal(report.mode, 'none')
  assert.equal(report.removed, 0)
})