// dsh-chameleon session-delete: CLIENT half.
//
// One shared delete dialog for every entry point:
//   - header danger button  (conversation.session.header.actions, order 30)
//   - sidebar session-row "..." menu item (DOM injection, title-matched)
// The dialog is a root-scoped shell.overlay occupant that listens for a
// window 'chameleon:delete-session' event carrying {sessionId, title,
// running}; both entry points dispatch it, so the sidebar item NEVER
// switches the conversation. The dialog shows the session name + id and a
// running warning; deleting a running session stops it on the host first
// (agent.cancel + quiescence) — the delete itself is always allowed.
// After the session is deleted, the files it produced are LISTED as a
// checkable list (everything pre-checked); only the user-confirmed
// selection is removed via /__chameleon/session/files/apply — keeping
// everything is a valid choice.
//
// Locale: all copy lives in the zh/en dictionaries below and follows the
// client's active language through the `locale` service (t seat for slot
// components, `locale/change` refresh for the DOM-injected menu item).
// Without the service, a browser-language sniff selects the dictionary.
//
// Bundle format (client-modules protocol): classic script registering a
// factory via window.__ModuleLoader__.load({ id, factory }); the factory
// receives `require` and returns the plugin's exports (apply etc.).
// No JSX: plain React.createElement. Theme tokens only (--dsw-*).
window.__ModuleLoader__.load({
  id: '@huanlin/dsh-plugin-session-delete',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useState } = React
    const { IconTrashOutline16, Modal } = require('@deepseek-ai/dsh-client-ui-primitives')

    const SLOT = 'conversation.session.header.actions'
    const ROW_ID = 'session-delete'
    const OVERLAY_SLOT = 'shell.overlay'
    const DIALOG_ID = 'session-delete-dialog'
    const EVENT = 'chameleon:delete-session'

    // --- locale -----------------------------------------------------------------
    // The copy follows the client's active language (zh/en). Dictionaries are
    // registered under our namespace with the `locale` service when it exists;
    // slot entries declare `locale: NS` so the renderer injects the `t` seat
    // (live re-render on switches). Without the service (minimal compositions)
    // a browser-language sniff keeps the English adaptation working.

    const NS = 'session-delete'

    const zhDict = {
      'dialog.title': '删除会话',
      'dialog.cancel': '取消',
      'dialog.confirm': '删除',
      'dialog.confirming': '删除中…',
      'dialog.deleting': '正在删除…',
      'dialog.done': '完成',
      'dialog.doneTitle': '会话已删除',
      'dialog.untitled': '未命名会话',
      'dialog.session': '会话：',
      'dialog.sessionId': '序列号：',
      'dialog.runningWarn': '⚠ 会话正在运行',
      'dialog.ack': '我已了解后果，确认删除',
      'dialog.notFoundDesc': '未能在会话列表中找到该会话（可能已被删除或列表尚未刷新），请刷新后重试。',
      'dialog.runningDesc': '该会话正在运行，删除会立即停止其任务并永久删除，正在进行的操作将中断且无法恢复。删除会话后会列出该会话期间新产生的文件（会话上传目录与工作区内新建的文件），可全部删除、按需删除或全部保留；会话修改过的既有文件默认保留。',
      'dialog.deleteDesc': '将永久删除该会话及其全部对话记录（会话日志、统计与工作区记账）。删除会话后会列出该会话期间新产生的文件（会话上传目录 .dsh-uploads/<会话ID> 与工作区内新建的文件），可全部删除、按需删除或全部保留；会话修改过的既有文件默认保留。此操作不可恢复。',
      'dialog.selectTitle': '清理会话文件',
      'dialog.selectDesc': '会话已删除。以下是该会话期间新产生的文件，请勾选需要删除的项（未勾选的将保留）：',
      'dialog.selectAll': '全选',
      'dialog.selectNone': '全不选',
      'dialog.deleteSelected': '删除所选（{0}）',
      'dialog.keepAll': '全部保留',
      'dialog.uploadDir': '上传目录',
      'dialog.modifiedHint': '另有 {0} 个会话修改过的既有文件，默认保留',
      'dialog.applying': '正在删除文件…',
      'dialog.selectedStats': '已选 {0} / {1} 项（{2}）',
      'dialog.summary.removed': '已删除会话期间新产生的文件 {0} 个（共 {1}）',
      'dialog.summary.uploads': '已清理会话上传目录 {0} 个',
      'dialog.summary.kept': '会话修改过的既有文件已保留 {0} 个',
      'dialog.summary.failed': '{0} 个文件删除失败（运行中的程序可能占用）',
      'dialog.summary.none': '没有文件被删除',
      'button.title': '删除会话',
      'button.titleRunning': '删除会话（运行中，删除将停止任务）',
      'menu.delete': '删除会话',
    }

    const enDict = {
      'dialog.title': 'Delete session',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Delete',
      'dialog.confirming': 'Deleting…',
      'dialog.deleting': 'Deleting…',
      'dialog.done': 'Done',
      'dialog.doneTitle': 'Session deleted',
      'dialog.untitled': 'Untitled session',
      'dialog.session': 'Session: ',
      'dialog.sessionId': 'Session ID: ',
      'dialog.runningWarn': '⚠ Session is running',
      'dialog.ack': 'I understand the consequences. Confirm deletion',
      'dialog.notFoundDesc': 'Could not find this session in the session list (it may have been deleted or the list has not refreshed yet). Please refresh and try again.',
      'dialog.runningDesc': 'This session is running. Deleting it will stop its task immediately and remove it permanently; any work in progress will be interrupted and cannot be recovered. After the session is deleted, the files it produced (the session upload directory and files it created in the workspace) are listed for you to remove — all, some, or none; pre-existing files the session modified are kept.',
      'dialog.deleteDesc': 'This will permanently delete the session and all of its conversation records (session log, statistics and workspace accounting). After the session is deleted, the files it produced (the session upload directory .dsh-uploads/<sessionId> and files it created in the workspace) are listed for you to remove — all, some, or none; pre-existing files the session modified are kept. This action cannot be undone.',
      'dialog.selectTitle': 'Clean up session files',
      'dialog.selectDesc': 'The session has been deleted. These files were produced during the session — check the ones to remove (unchecked items are kept):',
      'dialog.selectAll': 'Select all',
      'dialog.selectNone': 'Select none',
      'dialog.deleteSelected': 'Delete selected ({0})',
      'dialog.keepAll': 'Keep all',
      'dialog.uploadDir': 'upload dir',
      'dialog.modifiedHint': '{0} pre-existing file(s) the session modified are kept',
      'dialog.applying': 'Deleting files…',
      'dialog.selectedStats': '{0} / {1} selected ({2})',
      'dialog.summary.removed': 'Removed {0} file(s) created during the session ({1} in total)',
      'dialog.summary.uploads': 'Removed {0} session upload directory (directories)',
      'dialog.summary.kept': 'Kept {0} pre-existing file(s) that the session modified',
      'dialog.summary.failed': '{0} file(s) could not be removed (possibly locked by a running program)',
      'dialog.summary.none': 'No files were deleted',
      'button.title': 'Delete session',
      'button.titleRunning': 'Delete session (running — deleting will stop the task)',
      'menu.delete': 'Delete session',
    }

    const btnStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 28,
      height: 28,
      padding: 0,
      border: 'none',
      borderRadius: 6,
      background: 'transparent',
      color: 'var(--dsw-alias-label-tertiary, #8a8a8e)',
      cursor: 'pointer',
      flex: 'none',
    }

    const metaStyle = {
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
      fontSize: 13,
      lineHeight: '20px',
      margin: '0 0 10px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }

    const warnStyle = {
      color: 'var(--dsw-alias-state-warn-primary, #f5a524)',
      fontSize: 13,
      lineHeight: '20px',
      margin: '0 0 10px',
    }

    const errStyle = {
      color: 'var(--dsw-alias-state-error-primary, #e5484d)',
      fontSize: 12,
      lineHeight: '16px',
      marginTop: 8,
    }

    const statusStyle = {
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
      fontSize: 12,
      lineHeight: '16px',
      marginTop: 8,
    }

    const optStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontSize: 13,
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-primary, inherit)',
      marginTop: 10,
    }

    const cancelBtnStyle = {
      padding: '6px 14px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary, inherit)',
      fontSize: 13,
      cursor: 'pointer',
      marginRight: 8,
    }

    const dangerBtnStyle = {
      padding: '6px 14px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-state-error-primary, #e5484d)',
      background: 'var(--dsw-alias-state-error-primary, #e5484d)',
      color: '#fff',
      fontSize: 13,
      cursor: 'pointer',
    }

    // --- file-selection screen (post-delete, pre-removal) ----------------------

    const listToolbarStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      margin: '2px 0 6px',
      fontSize: 12,
      lineHeight: '16px',
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
    }

    const miniBtnStyle = {
      padding: '1px 8px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
      fontSize: 12,
      lineHeight: '18px',
      cursor: 'pointer',
    }

    const listStyle = {
      maxHeight: 280,
      overflowY: 'auto',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
      borderRadius: 8,
      padding: '4px 0',
    }

    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '4px 12px',
      fontSize: 13,
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-primary, inherit)',
      cursor: 'pointer',
      userSelect: 'none',
    }

    const relStyle = {
      flex: '1 1 auto',
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontFamily: 'var(--dsw-alias-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
      fontSize: 12,
    }

    const badgeStyle = {
      flex: 'none',
      fontSize: 11,
      lineHeight: '16px',
      padding: '0 6px',
      borderRadius: 4,
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
    }

    const sizeStyle = {
      flex: 'none',
      fontSize: 12,
      color: 'var(--dsw-alias-label-tertiary, #8a8a8e)',
    }

    // --- shared delete dialog (root overlay) -----------------------------------

    // Module-level handle to the client sessions service: set in apply() and
    // refreshed by a deferred inject, so the dialog always reads the live
    // service even when it was not ready at plugin apply time.
    var __sessionsSvc = null

    // Module-level handle to the client locale service (LocaleRuntime): set in
    // apply() and refreshed by a deferred inject. `__t` resolves through the
    // service's lookup chain (ns -> ns.zh -> common -> key) when present, and
    // falls back to the built-in dicts selected by browser language otherwise.
    var __locale = null

    function localeFallbackLang() {
      if (typeof navigator === 'undefined') return 'zh'
      for (const tag of (navigator.languages || []).concat([navigator.language])) {
        const primary = String(tag || '').toLowerCase().split('-')[0]
        if (primary === 'zh' || primary === 'en') return primary
      }
      return 'zh'
    }

    function __t(key) {
      if (__locale && typeof __locale.translate === 'function') {
        const text = __locale.translate(NS, key)
        if (typeof text === 'string' && text !== key) return text
      }
      return (localeFallbackLang() === 'en' ? enDict : zhDict)[key] || key
    }

    // Re-render on locale snapshot changes, so copy follows the active
    // language even when an entry was registered without the `locale` seat
    // (e.g. the locale service arrived after slot registration).
    function useLocaleRevision() {
      const [, setRev] = useState(0)
      useEffect(() => {
        if (!__locale || typeof __locale.subscribe !== 'function') return undefined
        return __locale.subscribe(() => setRev((v) => v + 1))
      }, [])
    }

    function normalizeTitle(t) {
      return String(t || '').trim().replace(/\s+/g, ' ')
    }

    // '标题 (1)' -> '标题' (fork-session display suffix)
    function stripForkSuffix(t) {
      return normalizeTitle(t).replace(/\s*\(\d+\)\s*$/, '')
    }

    // Resolve the target session from the client's authoritative list store.
    // The sidebar dispatches by title only (its DOM carries no id); the
    // header dispatches by id. Matching levels: exact -> fork-suffix-stripped
    // -> contains. A failed store match falls back to the host list endpoint.
    function resolveTargetFromStore(detail) {
      let sessionId = detail.sessionId || null
      let title = detail.title || null
      let running = detail.running === true
      if (sessionId) return { sessionId, title, running }
      const want = normalizeTitle(title)
      if (!want) return null
      const wantBase = stripForkSuffix(want)
      const svc = __sessionsSvc
      if (svc && svc.list) {
        try {
          const snap = svc.list.getSnapshot()
          const byId = snap && snap.byId ? snap.byId : {}
          const ids = Object.keys(byId)
          for (const id of ids) {
            const s = byId[id]
            if (s && normalizeTitle(s.title) === want) {
              return { sessionId: id, title: s.title, running: s.running === true }
            }
          }
          if (wantBase) {
            for (const id of ids) {
              const s = byId[id]
              if (s && stripForkSuffix(s.title) === wantBase) {
                return { sessionId: id, title: s.title, running: s.running === true }
              }
            }
          }
          let best = null
          for (const id of ids) {
            const s = byId[id]
            if (!s || !s.title) continue
            const t = normalizeTitle(s.title)
            if (t && (t.indexOf(want) >= 0 || want.indexOf(t) >= 0)) {
              best = { sessionId: id, title: s.title, running: s.running === true }
            }
          }
          if (best) return best
        } catch { /* ignore */ }
      }
      return null
    }

    // Human-readable byte formatting for the delete summary.
    function fmtBytes(n) {
      n = Number(n) || 0
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      return (n / (1024 * 1024)).toFixed(1) + ' MB'
    }

    // Format one `{0}`-placeheld copy string.
    function fmt(tpl) {
      for (let i = 1; i < arguments.length; i++) {
        tpl = tpl.replace('{' + (i - 1) + '}', String(arguments[i]))
      }
      return tpl
    }

    // Render the post-delete summary lines (host `files` report).
    function renderSummaryBlocks(files, t) {
      const blocks = []
      if (!files || files.removed + files.uploadDirsRemoved + files.failed === 0) {
        blocks.push(React.createElement('div', { key: 'none', style: statusStyle }, t('dialog.summary.none')))
        return blocks
      }
      if (files.removed > 0) {
        blocks.push(React.createElement('div', { key: 'removed', style: statusStyle },
          fmt(t('dialog.summary.removed'), files.removed, fmtBytes(files.bytes || 0))))
      }
      if (files.uploadDirsRemoved > 0) {
        blocks.push(React.createElement('div', { key: 'uploads', style: statusStyle },
          fmt(t('dialog.summary.uploads'), files.uploadDirsRemoved)))
      }
      if (files.failed > 0) {
        blocks.push(React.createElement('div', { key: 'failed', style: { ...errStyle, marginTop: 4 } },
          fmt(t('dialog.summary.failed'), files.failed)))
      }
      if (files.modifiedCount > 0) {
        blocks.push(React.createElement('div', { key: 'kept', style: { ...statusStyle, marginTop: 4 } },
          fmt(t('dialog.summary.kept'), files.modifiedCount)))
      }
      return blocks
    }

    function DeleteSessionDialog(props) {
      const t = (props && props.t) || __t
      useLocaleRevision()
      const [target, setTarget] = useState(null) // {sessionId, title, running, notFound}
      const [acknowledged, setAcknowledged] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)

      useEffect(() => {
        const handler = (e) => {
          const d = e && e.detail ? e.detail : {}
          const resolved = resolveTargetFromStore(d)
          if (resolved) {
            setTarget(resolved)
            setAcknowledged(false)
            setError(null)
            setBusy(false)
            return
          }
          // Store miss: fall back to the host session list (projection
          // cache titles), and surface a not-found dialog if that fails too
          // so a click is never silent.
          const want = normalizeTitle(d.title)
          if (!want) return
          fetch('/__chameleon/session/list')
            .then(function (r) { return r.json() })
            .then(function (data) {
              let m = null
              if (data && data.ok && Array.isArray(data.sessions)) {
                const wantBase = stripForkSuffix(want)
                for (const s of data.sessions) {
                  if (!s.title) continue
                  const t = normalizeTitle(s.title)
                  if (t === want || (wantBase && stripForkSuffix(t) === wantBase) || t.indexOf(want) >= 0 || want.indexOf(t) >= 0) {
                    m = s
                    break
                  }
                }
              }
              if (m) {
                setTarget({ sessionId: m.sessionId, title: m.title, running: m.running === true })
              } else {
                setTarget({ sessionId: null, title: want, running: false, notFound: true })
              }
              setAcknowledged(false)
              setError(null)
              setBusy(false)
            })
            .catch(function () {
              setTarget({ sessionId: null, title: want, running: false, notFound: true })
              setAcknowledged(false)
              setError(null)
              setBusy(false)
            })
        }
        window.addEventListener(EVENT, handler)
        return () => window.removeEventListener(EVENT, handler)
      }, [])

      const close = useCallback(() => {
        if (busy) return
        setTarget(null)
        setError(null)
      }, [busy])

      const confirm = useCallback(() => {
        if (busy || !acknowledged || !target) return
        setBusy(true)
        setError(null)
        fetch('/__chameleon/session/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: target.sessionId }),
        })
          .then(async (res) => {
            let data = {}
            try { data = await res.json() } catch { /* keep {} */ }
            if (!res.ok || !data.ok) {
              throw new Error(data.error || `delete failed (HTTP ${res.status})`)
            }
            // Deleted. Refresh the sidebar list in place — NO page reload —
            // and if the current session was deleted, open the first
            // remaining session so the user can keep working.
            const svc = __sessionsSvc
            const deletedCurrent = svc && svc.list
              ? svc.list.getSnapshot().current === target.sessionId
              : false
            if (data.filesPending && Array.isArray(data.filesPending.items) && data.filesPending.items.length > 0) {
              // Interactive file cleanup: nothing is deleted yet. Show the
              // produced-file list; everything starts CHECKED so a single
              // confirm removes all (the old auto-delete behavior), and
              // deselecting keeps files.
              const selected = {}
              for (const it of data.filesPending.items) selected[it.key] = true
              setTarget((prev) => (prev ? { ...prev, pending: data.filesPending, selected } : prev))
            } else {
              // Nothing produced (or the pending record could not be
              // persisted): straight to the summary screen.
              setTarget((prev) => (prev ? { ...prev, pending: null, selected: null, done: data.files || null } : prev))
            }
            setBusy(false)
            if (svc && typeof svc.refreshList === 'function') {
              const done = svc.refreshList()
              if (deletedCurrent) {
                Promise.resolve(done).then(() => {
                  try {
                    const snap = svc.list.getSnapshot()
                    const next = (snap && snap.ids || []).find((id) => id !== target.sessionId)
                    if (next && typeof svc.open === 'function') svc.open(next)
                  } catch { /* ignore */ }
                })
              }
            }
          })
          .catch((reason) => {
            setBusy(false)
            setError(reason && reason.message ? reason.message : String(reason))
          })
      }, [busy, acknowledged, target])

      // Phase 2: run the confirmed selection against the host (or keep
      // everything when `keepAll` is true — still clears the pending
      // record server-side).
      const applyFiles = useCallback((keepAll) => {
        if (busy || !target || !target.pending) return
        setBusy(true)
        setError(null)
        const keys = keepAll
          ? []
          : target.pending.items
              .filter((it) => target.selected && target.selected[it.key])
              .map((it) => it.key)
        fetch('/__chameleon/session/files/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: target.sessionId, selected: keys }),
        })
          .then(async (res) => {
            let data = {}
            try { data = await res.json() } catch { /* keep {} */ }
            if (res.status === 404) {
              // No pending record: already applied elsewhere (another tab,
              // or the record was swept). Nothing left to confirm.
              return { files: null }
            }
            if (!res.ok || !data.ok) {
              throw new Error(data.error || `file cleanup failed (HTTP ${res.status})`)
            }
            return { files: data.files || null }
          })
          .then((out) => {
            setTarget((prev) => (prev ? { ...prev, pending: null, selected: null, done: out.files } : prev))
            setBusy(false)
          })
          .catch((reason) => {
            setBusy(false)
            setError(reason && reason.message ? reason.message : String(reason))
          })
      }, [busy, target])

      const toggleItem = useCallback((key) => {
        setTarget((prev) => {
          if (!prev || !prev.selected) return prev
          const next = { ...prev.selected }
          if (next[key]) delete next[key]
          else next[key] = true
          return { ...prev, selected: next }
        })
      }, [])

      const setAllItems = useCallback((v) => {
        setTarget((prev) => {
          if (!prev || !prev.pending) return prev
          const next = {}
          if (v) for (const it of prev.pending.items) next[it.key] = true
          return { ...prev, selected: next }
        })
      }, [])

      if (!target) return null

      const done = target.done !== undefined
      const pending = !done && target.pending &&
        Array.isArray(target.pending.items) && target.pending.items.length > 0
      const name = target.notFound ? target.title || t('dialog.untitled') : (target.title || t('dialog.untitled'))
      const description = done || pending
        ? null
        : target.notFound
          ? t('dialog.notFoundDesc')
          : target.running
            ? t('dialog.runningDesc')
            : t('dialog.deleteDesc')

      // Done screen: report what was cleaned, one close button.
      if (done) {
        return React.createElement(Modal, {
          open: true,
          onClose: () => setTarget(null),
          title: t('dialog.doneTitle'),
          closeLabel: t('dialog.done'),
          description: null,
          footer: [
            React.createElement('button', {
              key: 'done',
              type: 'button',
              onClick: () => setTarget(null),
              style: dangerBtnStyle,
            }, t('dialog.done')),
          ],
        }, [
          React.createElement('div', { key: 'meta', style: metaStyle },
            t('dialog.session'), name,
            target.sessionId
              ? React.createElement(React.Fragment, null,
                  React.createElement('br'),
                  t('dialog.sessionId'), target.sessionId)
              : null),
          renderSummaryBlocks(target.done, t),
        ])
      }

      // File-selection screen: the session is already deleted; the user now
      // picks which of the produced files to remove. Nothing has been
      // deleted yet — the removal runs on confirm.
      if (pending) {
        const items = target.pending.items
        const selectedMap = target.selected || {}
        const selectedItems = items.filter((it) => selectedMap[it.key])
        const selectedBytes = selectedItems.reduce((acc, it) => acc + (Number(it.size) || 0), 0)
        const multiWorkspace = new Set(items.map((it) => it.workspacePath)).size > 1
        const allSelected = selectedItems.length === items.length
        const wsLabel = (wsPath) => {
          const parts = String(wsPath || '').split(/[\\/]/).filter(Boolean)
          return parts.length > 0 ? parts[parts.length - 1] : ''
        }

        return React.createElement(Modal, {
          open: true,
          onClose: close,
          title: t('dialog.selectTitle'),
          closeLabel: t('dialog.cancel'),
          description: t('dialog.selectDesc'),
          footer: [
            React.createElement('button', {
              key: 'keepAll',
              type: 'button',
              disabled: busy,
              onClick: () => applyFiles(true),
              style: { ...cancelBtnStyle, ...(busy ? { opacity: 0.5, cursor: 'default' } : {}) },
            }, t('dialog.keepAll')),
            React.createElement('button', {
              key: 'apply',
              type: 'button',
              disabled: busy || selectedItems.length === 0,
              onClick: () => applyFiles(false),
              style: { ...dangerBtnStyle, ...(busy || selectedItems.length === 0 ? { opacity: 0.5, cursor: 'default' } : {}) },
            }, busy ? t('dialog.applying') : fmt(t('dialog.deleteSelected'), selectedItems.length)),
          ],
        }, [
          React.createElement('div', { key: 'meta', style: metaStyle },
            t('dialog.session'), name,
            target.sessionId
              ? React.createElement(React.Fragment, null,
                  React.createElement('br'),
                  t('dialog.sessionId'), target.sessionId)
              : null),
          React.createElement('div', { key: 'toolbar', style: listToolbarStyle },
            React.createElement('button', {
              type: 'button',
              disabled: busy,
              onClick: () => setAllItems(!allSelected),
              style: { ...miniBtnStyle, ...(busy ? { opacity: 0.5, cursor: 'default' } : {}) },
            }, allSelected ? t('dialog.selectNone') : t('dialog.selectAll')),
            fmt(t('dialog.selectedStats'), selectedItems.length, items.length, fmtBytes(selectedBytes))),
          React.createElement('div', { key: 'list', style: listStyle },
            items.map((it) => React.createElement('label', {
              key: it.key,
              style: rowStyle,
              title: it.abs || it.rel,
            },
              React.createElement('input', {
                type: 'checkbox',
                checked: !!selectedMap[it.key],
                disabled: busy,
                onChange: () => toggleItem(it.key),
              }),
              React.createElement('span', { style: relStyle },
                multiWorkspace && it.workspacePath
                  ? `${wsLabel(it.workspacePath)}/${it.rel}`
                  : it.rel),
              it.kind === 'uploadDir'
                ? React.createElement('span', { key: 'badge', style: badgeStyle }, t('dialog.uploadDir'))
                : null,
              React.createElement('span', { style: sizeStyle }, fmtBytes(Number(it.size) || 0))))),
          target.pending.modifiedCount > 0
            ? React.createElement('div', { key: 'mod', style: statusStyle },
                fmt(t('dialog.modifiedHint'), target.pending.modifiedCount))
            : null,
          busy ? React.createElement('div', { key: 'busy', style: statusStyle }, t('dialog.applying')) : null,
          error ? React.createElement('div', { key: 'err', style: errStyle, role: 'alert' }, error) : null,
        ])
      }

      return React.createElement(Modal, {
        open: true,
        onClose: close,
        title: t('dialog.title'),
        closeLabel: t('dialog.cancel'),
        description,
        footer: [
          React.createElement('button', {
            key: 'cancel',
            type: 'button',
            disabled: busy,
            onClick: close,
            style: { ...cancelBtnStyle, ...(busy ? { opacity: 0.5, cursor: 'default' } : {}) },
          }, t('dialog.cancel')),
          React.createElement('button', {
            key: 'confirm',
            type: 'button',
            disabled: busy || !acknowledged || !target.sessionId,
            onClick: confirm,
            style: { ...dangerBtnStyle, ...(busy || !acknowledged || !target.sessionId ? { opacity: 0.5, cursor: 'default' } : {}) },
          }, busy ? t('dialog.confirming') : t('dialog.confirm')),
        ],
      }, [
        React.createElement('div', { key: 'meta', style: metaStyle },
          t('dialog.session'), name,
          target.sessionId
            ? React.createElement(React.Fragment, null,
                React.createElement('br'),
                t('dialog.sessionId'), target.sessionId)
            : null),
        target.running
          ? React.createElement('div', { key: 'warn', style: warnStyle }, t('dialog.runningWarn'))
          : null,
        React.createElement('label', { key: 'ack', style: optStyle },
          React.createElement('input', {
            type: 'checkbox',
            checked: acknowledged,
            disabled: busy,
            onChange: (e) => setAcknowledged(e.target.checked),
          }),
          t('dialog.ack')),
        busy ? React.createElement('div', { key: 'busy', style: statusStyle }, t('dialog.deleting')) : null,
        error ? React.createElement('div', { key: 'err', style: errStyle, role: 'alert' }, error) : null,
      ])
    }

    // --- header danger button ---------------------------------------------------

    function DeleteSessionButton(props) {
      const { sessionId, useSessions } = props
      const t = (props && props.t) || __t
      useLocaleRevision()
      const sessions = useSessions ? useSessions((s) => s) : undefined
      const summary = sessions && sessions.byId ? sessions.byId[sessionId] : undefined
      const running = summary ? summary.running === true : false

      const openDialog = useCallback(() => {
        window.dispatchEvent(new CustomEvent(EVENT, {
          detail: {
            sessionId,
            title: summary && summary.title ? summary.title : null,
            running,
          },
        }))
      }, [sessionId, summary, running])

      return React.createElement('button', {
        type: 'button',
        title: running ? t('button.titleRunning') : t('button.title'),
        'aria-label': t('button.title'),
        style: btnStyle,
        onClick: openDialog,
      }, React.createElement(IconTrashOutline16, { size: 16 }))
    }

    // --- sidebar session-row menu injection ------------------------------------
    // rc.6's session-row "..." menu (rename/fork/archive) is hard-coded in
    // ui-workspace with no extension slot, so the delete item is injected at
    // the DOM level. Clicking it matches the row title against the host
    // session list and opens the shared dialog WITHOUT switching sessions.
    // This module is composed into both the desktop client and web.

    var TRASH_PATH = 'M14.4782 4.84067L14.2138 10.1152C14.1102 12.1872 14.067 13.0115 13.3866 13.9607C13.1044 14.3546 12.7498 14.6912 12.3424 14.9535C11.8239 15.2872 11.2415 15.4316 10.5585 15.4998C9.88727 15.5668 9.04946 15.5656 7.99998 15.5656C6.95051 15.5656 6.1127 15.5668 5.44142 15.4998C4.75851 15.4316 4.17602 15.2872 3.65753 14.9535C3.25012 14.6912 2.89559 14.3546 2.61332 13.9607C1.93296 13.0115 1.88979 12.1872 1.78619 10.1152L1.52179 4.84067L2.89006 4.77277L3.15343 10.0463C3.26221 12.2218 3.32452 12.6015 3.72646 13.1624C3.90825 13.4161 4.13686 13.6334 4.39927 13.8023C4.66204 13.9714 5.00263 14.0792 5.57825 14.1367C6.16562 14.1953 6.92298 14.1963 7.99998 14.1963C9.07699 14.1963 9.83434 14.1953 10.4217 14.1367C10.9973 14.0792 11.3379 13.9714 11.6007 13.8023C11.8631 13.6334 12.0917 13.4161 12.2735 13.1624C12.6755 12.6015 12.7378 12.2218 12.8465 10.0463L13.1099 4.77277L14.4782 4.84067ZM5.43011 6.22849H6.7994V11.3909H5.43011V6.22849ZM9.20056 6.22849H10.5699V11.3909H9.20056V6.22849ZM8.53597 0.434431C9.17976 0.434431 9.6522 0.426926 10.0966 0.571258C10.2357 0.616451 10.3717 0.672554 10.502 0.738948C10.9182 0.951107 11.2464 1.29099 11.7015 1.74612L12.4978 2.54136H15.3742V3.91169H0.625732V2.54136H3.50218L4.29845 1.74612C4.75358 1.29099 5.08174 0.951107 5.49801 0.738948C5.62831 0.672554 5.76425 0.616451 5.90334 0.571258C6.34776 0.426926 6.82021 0.434431 7.46399 0.434431H8.53597ZM7.46399 1.80476C6.73208 1.80476 6.51641 1.81187 6.32617 1.87369C6.25545 1.89667 6.18668 1.92533 6.12041 1.95907C5.96398 2.03878 5.82348 2.16253 5.44142 2.54136H10.5585C10.1765 2.16253 10.036 2.03878 9.87955 1.95907C9.81329 1.92533 9.74452 1.89667 9.6738 1.87369C9.48356 1.81187 9.26789 1.80476 8.53597 1.80476H7.46399Z'

    // Dispatch the row's title to the shared dialog; the dialog resolves the
    // session id from the client's list store (same data the sidebar shows).
    // Never switches the active conversation and needs no host round-trip.
    function openDeleteFlow(row) {
      if (!row) return
      var titleEl = row.querySelector('[class*=title]')
      var title = titleEl ? String(titleEl.innerText || '').trim() : ''
      if (!title) return
      window.dispatchEvent(new CustomEvent(EVENT, { detail: { title } }))
    }

    function ensureSidebarDeleteItem() {
      var menu = document.querySelector('[role=menu]')
      if (!menu) return
      if (menu.querySelector('[data-chameleon-delete]')) return
      var row = findOpenSessionRow()
      if (!row) return // not a session-row menu
      var item = document.createElement('button')
      item.type = 'button'
      item.setAttribute('role', 'menuitem')
      item.setAttribute('data-chameleon-delete', '1')
      item.style.cssText = [
        'display:flex', 'align-items:center', 'gap:8px', 'width:100%',
        'padding:6px 12px', 'border:none', 'background:transparent',
        'color:var(--dsw-alias-state-error-primary,#e5484d)',
        'font:inherit', 'font-size:13px', 'line-height:20px',
        'text-align:left', 'border-radius:6px', 'cursor:pointer',
      ].join(';')
      item.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex:none"><path d="' + TRASH_PATH + '" fill="currentColor"/></svg><span></span>'
      item.querySelector('span').textContent = __t('menu.delete')
      item.addEventListener('mouseenter', function () {
        item.style.background = 'var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))'
      })
      item.addEventListener('mouseleave', function () {
        item.style.background = 'transparent'
      })
      item.addEventListener('click', function () { openDeleteFlow(row) })
      var sep = document.createElement('div')
      sep.style.cssText = 'height:1px;margin:4px 8px;background:var(--dsw-alias-border-l1,rgba(128,128,128,.2))'
      menu.appendChild(sep)
      menu.appendChild(item)
    }

    function findOpenSessionRow() {
      var rows = document.querySelectorAll('[class*=sessionRow]')
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i].className || '').indexOf('menuOpen') >= 0) return rows[i]
      }
      return null
    }

    // Keep an already-open sidebar menu's label in the active language when
    // the locale switches (fresh menus already read `__t` at creation time).
    function refreshSidebarDeleteLabel() {
      const items = document.querySelectorAll('[data-chameleon-delete]')
      for (let i = 0; i < items.length; i++) {
        const span = items[i].querySelector('span')
        if (span) span.textContent = __t('menu.delete')
      }
    }

    function installSidebarDelete() {
      if (window.__chameleonSidebarDeleteInstalled) return
      window.__chameleonSidebarDeleteInstalled = true
      try { ensureSidebarDeleteItem() } catch (e) { /* never crash the UI */ }
      var observer = new MutationObserver(function () {
        try { ensureSidebarDeleteItem() } catch (e) { /* never crash the UI */ }
      })
      observer.observe(document.body, { childList: true, subtree: true })
    }

    // --- apply ------------------------------------------------------------------

    // Adopt the client locale service: register our zh/en dictionaries (the
    // lookup chain falls back to zh, so a missing en entry still renders) and
    // refresh any DOM-injected copy. Disposal of the dictionary registration
    // rides the plugin fiber through ctx.effect.
    function adoptLocale(locale, ctx) {
      if (!locale) return
      __locale = locale
      try {
        if (typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NS, { zh: zhDict, en: enDict }))
        }
      } catch { /* namespace already registered: keep the existing copy */ }
    }

    function apply(ctx) {
      // The client sessions service (list store, refreshList, open) powers the
      // dialog: title resolution and in-place list refresh after deletion.
      // Grab it now; if it is not ready yet, a deferred inject refreshes the
      // module-level handle and the dialog picks it up.
      __sessionsSvc = ctx.get('sessions')
      if (!__sessionsSvc) {
        ctx.inject(['sessions'], (sub) => {
          __sessionsSvc = sub.sessions
        })
      }
      // The locale service drives the zh/en copy. Absent a deferred inject
      // (minimal compositions), `__t` falls back to the built-in dicts.
      adoptLocale(ctx.get('locale'), ctx)
      if (!__locale) {
        ctx.inject(['locale'], (sub) => {
          adoptLocale(sub.locale, ctx)
          refreshSidebarDeleteLabel()
        })
      }
      ctx.on('locale/change', refreshSidebarDeleteLabel)
      // `locale: NS` gives the registered components the `t` seat (the
      // renderer re-derives it on every locale switch); without the service
      // the components fall back to `__t` + useLocaleRevision().
      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: ROW_ID,
        order: 30,
        ...(__locale ? { locale: NS } : {}),
      }, DeleteSessionButton))
      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT,
        id: DIALOG_ID,
        order: 100,
        ...(__locale ? { locale: NS } : {}),
      }, DeleteSessionDialog))
      installSidebarDelete()
    }

    // The loader gates apply() until the declared services exist.
    return { apply, inject: ['slots'] }
  },
})
