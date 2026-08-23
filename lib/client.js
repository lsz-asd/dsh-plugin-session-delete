// dsh-chameleon session-delete: CLIENT half.
//
// Session actions include confirmed archive/delete flows and a sidebar archive
// manager. The manager lists archived sessions and provides restore/delete per
// row; restore keeps the durable log and workspace position.
// Delete entry points remain title-safe and never switch the conversation.
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
    const { IconArchiveOutline20, IconFolderOpenOutline16, IconTrashOutline16, Modal } = require('@deepseek-ai/dsh-client-ui-primitives')
    const ArchiveManagerIcon = IconFolderOpenOutline16 || IconArchiveOutline20

    const SLOT = 'conversation.session.header.actions'
    const MANAGER_SLOT = 'sidebar.footer.action'
    const ROW_ID = 'session-delete'
    const ARCHIVE_ROW_ID = 'session-archive'
    const MANAGER_ROW_ID = 'session-archive-manager'
    const OVERLAY_SLOT = 'shell.overlay'
    const DIALOG_ID = 'session-delete-dialog'
    const EVENT = 'chameleon:delete-session'
    const ARCHIVE_EVENT = 'chameleon:archive-session'

    // --- locale -----------------------------------------------------------------
    // The copy follows the client's active language (zh/en). Dictionaries are
    // registered under our namespace with the `locale` service when it exists;
    // slot entries declare `locale: NS` so the renderer injects the `t` seat
    // (live re-render on switches). Without the service (minimal compositions)
    // a browser-language sniff keeps the English adaptation working.

    const NS = 'session-delete'

    const zhDict = {
      'dialog.title': '删除会话',
      'dialog.archiveTitle': '归档会话',
      'dialog.cancel': '取消',
      'dialog.confirm': '删除',
      'dialog.archiveConfirm': '归档',
      'dialog.confirming': '删除中…',
      'dialog.archiving': '归档中…',
      'dialog.deleting': '正在删除…',
      'dialog.untitled': '未命名会话',
      'dialog.session': '会话：',
      'dialog.sessionId': '序列号：',
      'dialog.runningWarn': '⚠ 会话正在运行',
      'dialog.archiveRunningWarn': '⚠ 会话正在运行，归档不会停止任务',
      'dialog.ack': '我已了解后果，确认删除',
      'dialog.archiveAck': '我已了解：归档后会话将从列表隐藏，但记录会保留',
      'dialog.notFoundDesc': '未能在会话列表中找到该会话（可能已被删除或列表尚未刷新），请刷新后重试。',
      'dialog.runningDesc': '该会话正在运行，删除会立即停止其任务并永久删除，正在进行的操作将中断且无法恢复。',
      'dialog.archiveRunningDesc': '该会话正在运行。归档只会将它从列表隐藏，不会停止正在执行的任务。',
      'dialog.deleteDesc': '将永久删除该会话及其全部对话记录（会话日志、统计与工作区记账），此操作不可恢复。',
      'dialog.archiveDesc': '归档不会删除对话记录、统计或工作区归属；会话会从列表隐藏，保留在归档集合中。',
      'button.title': '删除会话',
      'button.titleRunning': '删除会话（运行中，删除将停止任务）',
      'button.archiveTitle': '归档会话',
      'button.archiveTitleRunning': '归档会话（运行中，任务不会停止）',
      'menu.delete': '删除会话',
      'menu.archive': '归档会话',
      'manager.title': '归档会话管理',
      'manager.button': '归档管理',
      'manager.loading': '正在加载归档会话…',
      'manager.empty': '暂无归档会话',
      'manager.refresh': '刷新',
      'manager.close': '关闭',
      'manager.cancel': '取消',
      'manager.restore': '恢复',
      'manager.restoring': '恢复中…',
      'manager.delete': '删除',
      'manager.deleting': '删除中…',
      'manager.untitled': '未命名会话',
      'manager.id': '序列号：',
      'manager.deleteTitle': '删除归档会话',
      'manager.deleteDesc': '将永久删除该归档会话及其全部记录，此操作不可恢复。',
      'manager.deleteAck': '我已了解后果，确认删除',
      'manager.deleteConfirm': '删除',
    }

    const enDict = {
      'dialog.title': 'Delete session',
      'dialog.archiveTitle': 'Archive session',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Delete',
      'dialog.archiveConfirm': 'Archive',
      'dialog.confirming': 'Deleting…',
      'dialog.archiving': 'Archiving…',
      'dialog.deleting': 'Deleting…',
      'dialog.untitled': 'Untitled session',
      'dialog.session': 'Session: ',
      'dialog.sessionId': 'Session ID: ',
      'dialog.runningWarn': '⚠ Session is running',
      'dialog.archiveRunningWarn': '⚠ Session is running; archiving will not stop the task',
      'dialog.ack': 'I understand the consequences. Confirm deletion',
      'dialog.archiveAck': 'I understand: archiving hides the session but keeps its records',
      'dialog.notFoundDesc': 'Could not find this session in the session list (it may have been deleted or the list has not refreshed yet). Please refresh and try again.',
      'dialog.runningDesc': 'This session is running. Deleting it will stop its task immediately and remove it permanently; any work in progress will be interrupted and cannot be recovered.',
      'dialog.archiveRunningDesc': 'This session is running. Archiving only hides it from the list; the task will continue running.',
      'dialog.deleteDesc': 'This will permanently delete the session and all of its conversation records (session log, statistics and workspace accounting). This action cannot be undone.',
      'dialog.archiveDesc': 'Archiving does not delete conversation records, statistics, or workspace membership. The session is hidden in the archive set.',
      'button.title': 'Delete session',
      'button.titleRunning': 'Delete session (running — deleting will stop the task)',
      'button.archiveTitle': 'Archive session',
      'button.archiveTitleRunning': 'Archive session (running — the task will continue)',
      'menu.delete': 'Delete session',
      'menu.archive': 'Archive session',
      'manager.title': 'Archived sessions',
      'manager.button': 'Archive manager',
      'manager.loading': 'Loading archived sessions…',
      'manager.empty': 'No archived sessions',
      'manager.refresh': 'Refresh',
      'manager.close': 'Close',
      'manager.cancel': 'Cancel',
      'manager.restore': 'Restore',
      'manager.restoring': 'Restoring…',
      'manager.delete': 'Delete',
      'manager.deleting': 'Deleting…',
      'manager.untitled': 'Untitled session',
      'manager.id': 'Session ID: ',
      'manager.deleteTitle': 'Delete archived session',
      'manager.deleteDesc': 'This permanently deletes the archived session and all of its records. This action cannot be undone.',
      'manager.deleteAck': 'I understand the consequences. Confirm deletion',
      'manager.deleteConfirm': 'Delete',
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

    const archiveIconBtnStyle = {
      ...btnStyle,
      color: 'var(--dsw-alias-interactive-primary, #4c8dff)',
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

    const archiveBtnStyle = {
      padding: '6px 14px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-interactive-primary, #4c8dff)',
      background: 'var(--dsw-alias-interactive-primary, #4c8dff)',
      color: '#fff',
      fontSize: 13,
      cursor: 'pointer',
    }

    const managerButtonStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      width: '100%',
      minHeight: 36,
      padding: '0 12px',
      border: 'none',
      borderRadius: 10,
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
      cursor: 'pointer',
      font: 'inherit',
      fontSize: 13,
      textAlign: 'left',
    }

    const managerListStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      maxHeight: 420,
      overflowY: 'auto',
    }

    const managerRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      minWidth: 0,
      padding: '10px 12px',
      border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2))',
      borderRadius: 8,
    }

    const managerRowMainStyle = {
      minWidth: 0,
      flex: 1,
    }

    const managerTitleStyle = {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      color: 'var(--dsw-alias-label-primary, inherit)',
      fontSize: 13,
      lineHeight: '20px',
    }

    const managerIdStyle = {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      color: 'var(--dsw-alias-label-tertiary, #8a8a8e)',
      fontSize: 11,
      lineHeight: '16px',
    }

    const managerActionsStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      flex: 'none',
    }

    const managerActionStyle = {
      padding: '4px 9px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary, inherit)',
      fontSize: 12,
      cursor: 'pointer',
    }

    const managerDeleteActionStyle = {
      ...managerActionStyle,
      borderColor: 'var(--dsw-alias-state-error-primary, #e5484d)',
      color: 'var(--dsw-alias-state-error-primary, #e5484d)',
    }

    const managerEmptyStyle = {
      padding: '28px 12px',
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
      textAlign: 'center',
      fontSize: 13,
    }

    // --- shared session-action dialog (root overlay) ----------------------------

    // Module-level handle to the client sessions service: set in apply() and
    // refreshed by a deferred inject, so the dialog always reads the live
    // service even when it was not ready at plugin apply time.
    var __sessionsSvc = null
    var __workspacesSvc = null

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

    // Title matching is only a fallback for old DOM shells. Never choose a
    // fuzzy match when more than one session could own the same title.
    function findUniqueTitleMatch(items, wanted) {
      const want = normalizeTitle(wanted)
      if (!want) return null
      const titled = items.filter((item) => item && normalizeTitle(item.title))
      const exact = titled.filter((item) => normalizeTitle(item.title) === want)
      if (exact.length === 1) return exact[0]
      if (exact.length > 1) return null
      const base = stripForkSuffix(want)
      const sameBase = base ? titled.filter((item) => stripForkSuffix(item.title) === base) : []
      if (sameBase.length === 1) return sameBase[0]
      if (sameBase.length > 1) return null
      const fuzzy = titled.filter((item) => {
        const title = normalizeTitle(item.title)
        return title.indexOf(want) >= 0 || want.indexOf(title) >= 0
      })
      return fuzzy.length === 1 ? fuzzy[0] : null
    }

    // Resolve the target session from the client's authoritative list store.
    // The sidebar dispatches by title only in older shells; the header and newer
    // row markup dispatch by id. Ambiguous title matches are rejected.
    function resolveTargetFromStore(detail) {
      let sessionId = detail.sessionId || null
      let title = detail.title || null
      let running = detail.running === true
      if (sessionId) return { sessionId, title, running }
      const want = normalizeTitle(title)
      if (!want) return null
      const svc = __sessionsSvc
      if (svc && svc.list) {
        try {
          const snap = svc.list.getSnapshot()
          const byId = snap && snap.byId ? snap.byId : {}
          const candidates = Object.keys(byId).map((id) => {
            const summary = byId[id]
            return summary && summary.title
              ? { sessionId: id, title: summary.title, running: summary.running === true }
              : null
          }).filter(Boolean)
          const match = findUniqueTitleMatch(candidates, want)
          if (match) return match
        } catch { /* ignore */ }
      }
      return null
    }

    // Prefer the official client WorkspaceRuntime so the local archive echo and
    // host/archived-sessions-changed frames update every UI surface immediately.
    // The endpoint is a compatibility fallback for older client shells.
    function archiveSessionRequest(sessionId) {
      const workspaces = __workspacesSvc
      if (workspaces && typeof workspaces.archiveSession === 'function') {
        return Promise.resolve(workspaces.archiveSession(sessionId)).then(() => ({ direct: true }))
      }
      return fetch('/__chameleon/session/archive', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      }).then(async (res) => {
        let data = {}
        try { data = await res.json() } catch { /* keep {} */ }
        if (!res.ok || !data.ok) {
          throw new Error(data.error || 'archive failed (HTTP ' + res.status + ')')
        }
        return { direct: false }
      })
    }

    function postJson(url, payload) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(async (res) => {
        let data = {}
        try { data = await res.json() } catch { /* keep {} */ }
        if (!res.ok || !data.ok) {
          throw new Error(data.error || ('request failed (HTTP ' + res.status + ')'))
        }
        return data
      })
    }

    function loadArchivedSessions() {
      return fetch('/__chameleon/session/archive/list').then(async (res) => {
        let data = {}
        try { data = await res.json() } catch { /* keep {} */ }
        if (!res.ok || !data.ok) {
          throw new Error(data.error || ('archive list failed (HTTP ' + res.status + ')'))
        }
        return Array.isArray(data.sessions) ? data.sessions : []
      })
    }

    function refreshAfterArchiveMutation() {
      const tasks = []
      if (__workspacesSvc && typeof __workspacesSvc.refresh === 'function') {
        tasks.push(Promise.resolve(__workspacesSvc.refresh()).catch(() => undefined))
      }
      if (__sessionsSvc && typeof __sessionsSvc.refreshList === 'function') {
        tasks.push(Promise.resolve(__sessionsSvc.refreshList()).catch(() => undefined))
      }
      return Promise.all(tasks)
    }

    function ArchiveManagerButton(props) {
      const t = (props && props.t) || __t
      useLocaleRevision()
      const wide = props && props.wide !== false
      const [open, setOpen] = useState(false)
      const openManager = useCallback(() => setOpen(true), [])
      const closeManager = useCallback(() => setOpen(false), [])
      return React.createElement(React.Fragment, null,
        React.createElement('button', {
          type: 'button',
          title: t('manager.title'),
          'aria-label': t('manager.title'),
          style: managerButtonStyle,
          onClick: openManager,
          onMouseEnter: (e) => { e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))' },
          onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
        },
          React.createElement(ArchiveManagerIcon, { size: 16 }),
          wide ? React.createElement('span', null, t('manager.button')) : null,
        ),
        React.createElement(ArchiveManagerDialog, { open, onClose: closeManager, t }),
      )
    }

    function ArchiveManagerDialog(props) {
      const t = (props && props.t) || __t
      useLocaleRevision()
      const open = props && props.open === true
      const [items, setItems] = useState([])
      const [phase, setPhase] = useState('idle')
      const [error, setError] = useState(null)
      const [busyId, setBusyId] = useState(null)
      const [deleteTarget, setDeleteTarget] = useState(null)
      const [acknowledged, setAcknowledged] = useState(false)

      const load = useCallback(() => {
        setPhase('loading')
        setError(null)
        return loadArchivedSessions().then((sessions) => {
          setItems(sessions)
          setPhase('ready')
          return sessions
        }).catch((reason) => {
          setPhase('error')
          setError(reason && reason.message ? reason.message : String(reason))
          return []
        })
      }, [])

      useEffect(() => {
        if (!open) return
        setDeleteTarget(null)
        setAcknowledged(false)
        load()
      }, [open, load])

      const close = useCallback(() => {
        if (busyId) return
        setDeleteTarget(null)
        setAcknowledged(false)
        setError(null)
        if (props && typeof props.onClose === 'function') props.onClose()
      }, [busyId, props && props.onClose])

      const restore = useCallback((item) => {
        if (busyId || !item || !item.sessionId) return
        setBusyId(item.sessionId)
        setError(null)
        postJson('/__chameleon/session/archive/restore', { sessionId: item.sessionId })
          .then(() => {
            setItems((current) => current.filter((entry) => entry.sessionId !== item.sessionId))
            setBusyId(null)
            return refreshAfterArchiveMutation()
          })
          .catch((reason) => {
            setBusyId(null)
            setError(reason && reason.message ? reason.message : String(reason))
          })
      }, [busyId])

      const requestDelete = useCallback((item) => {
        if (busyId) return
        setDeleteTarget(item)
        setAcknowledged(false)
        setError(null)
      }, [busyId])

      const confirmDelete = useCallback(() => {
        if (busyId || !acknowledged || !deleteTarget || !deleteTarget.sessionId) return
        const sessionId = deleteTarget.sessionId
        setBusyId(sessionId)
        setError(null)
        postJson('/__chameleon/session/delete', { sessionId })
          .then(() => {
            setItems((current) => current.filter((entry) => entry.sessionId !== sessionId))
            setDeleteTarget(null)
            setAcknowledged(false)
            setBusyId(null)
            return refreshAfterArchiveMutation()
          })
          .catch((reason) => {
            setBusyId(null)
            setError(reason && reason.message ? reason.message : String(reason))
          })
      }, [busyId, acknowledged, deleteTarget])

      if (!open) return null

      const deleting = !!deleteTarget
      const listBody = phase === 'loading'
        ? React.createElement('div', { key: 'loading', style: managerEmptyStyle, role: 'status' }, t('manager.loading'))
        : phase === 'error'
          ? React.createElement('div', { key: 'error', style: errStyle, role: 'alert' }, error)
          : items.length === 0
            ? React.createElement('div', { key: 'empty', style: managerEmptyStyle }, t('manager.empty'))
            : React.createElement('div', { key: 'list', style: managerListStyle }, items.map((item) => {
                const itemBusy = busyId === item.sessionId
                return React.createElement('div', { key: item.sessionId, style: managerRowStyle },
                  React.createElement('div', { style: managerRowMainStyle },
                    React.createElement('div', { style: managerTitleStyle }, item.title || t('manager.untitled')),
                    React.createElement('div', { style: managerIdStyle }, t('manager.id') + item.sessionId),
                  ),
                  React.createElement('div', { style: managerActionsStyle },
                    React.createElement('button', {
                      type: 'button',
                      disabled: !!busyId,
                      style: { ...managerActionStyle, ...(itemBusy ? { opacity: 0.5, cursor: 'default' } : {}) },
                      onClick: () => restore(item),
                    }, itemBusy ? t('manager.restoring') : t('manager.restore')),
                    React.createElement('button', {
                      type: 'button',
                      disabled: !!busyId,
                      style: { ...managerDeleteActionStyle, ...(busyId ? { opacity: 0.5, cursor: 'default' } : {}) },
                      onClick: () => requestDelete(item),
                    }, t('manager.delete')),
                  ),
                )
              }))

      const deleteBody = deleteTarget ? [
        React.createElement('div', { key: 'delete-meta', style: metaStyle },
          deleteTarget.title || t('manager.untitled'),
          React.createElement('br'),
          t('manager.id') + deleteTarget.sessionId),
        React.createElement('label', { key: 'delete-ack', style: optStyle },
          React.createElement('input', {
            type: 'checkbox',
            checked: acknowledged,
            disabled: !!busyId,
            onChange: (e) => setAcknowledged(e.target.checked),
          }),
          t('manager.deleteAck')),
        error ? React.createElement('div', { key: 'delete-error', style: errStyle, role: 'alert' }, error) : null,
      ] : null

      return React.createElement(Modal, {
        open: true,
        onClose: close,
        title: deleting ? t('manager.deleteTitle') : t('manager.title'),
        closeLabel: t('manager.close'),
        description: deleting ? t('manager.deleteDesc') : undefined,
        footer: deleting ? [
          React.createElement('button', {
            key: 'cancel-delete',
            type: 'button',
            disabled: !!busyId,
            style: { ...cancelBtnStyle, ...(busyId ? { opacity: 0.5, cursor: 'default' } : {}) },
            onClick: () => { if (!busyId) { setDeleteTarget(null); setAcknowledged(false); setError(null) } },
          }, t('manager.cancel')),
          React.createElement('button', {
            key: 'confirm-delete',
            type: 'button',
            disabled: !!busyId || !acknowledged,
            style: { ...dangerBtnStyle, ...(busyId || !acknowledged ? { opacity: 0.5, cursor: 'default' } : {}) },
            onClick: confirmDelete,
          }, busyId ? t('manager.deleting') : t('manager.deleteConfirm')),
        ] : [
          React.createElement('button', {
            key: 'close-manager',
            type: 'button',
            disabled: !!busyId,
            style: { ...cancelBtnStyle, ...(busyId ? { opacity: 0.5, cursor: 'default' } : {}) },
            onClick: close,
          }, t('manager.close')),
          React.createElement('button', {
            key: 'refresh-manager',
            type: 'button',
            disabled: phase === 'loading' || !!busyId,
            style: { ...archiveBtnStyle, ...(phase === 'loading' || busyId ? { opacity: 0.5, cursor: 'default' } : {}) },
            onClick: load,
          }, t('manager.refresh')),
        ],
      }, deleting ? deleteBody : [
        listBody,
        error && phase !== 'error' ? React.createElement('div', { key: 'action-error', style: errStyle, role: 'alert' }, error) : null,
      ])
    }

    function DeleteSessionDialog(props) {
      const t = (props && props.t) || __t
      useLocaleRevision()
      const [target, setTarget] = useState(null) // {sessionId, title, running, notFound}
      const [acknowledged, setAcknowledged] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)

      useEffect(() => {
        const open = (action, d) => {
          const resolved = resolveTargetFromStore(d)
          if (resolved) {
            setTarget({ ...resolved, action })
            setAcknowledged(false)
            setError(null)
            setBusy(false)
            return
          }
          // Store miss: fall back to the host session list (projection cache
          // titles), and surface a not-found dialog if that fails too.
          const want = normalizeTitle(d.title)
          if (!want) return
          fetch('/__chameleon/session/list')
            .then(function (r) { return r.json() })
            .then(function (data) {
              let m = null
              if (data && data.ok && Array.isArray(data.sessions)) {
                m = findUniqueTitleMatch(data.sessions.filter((s) => s && !s.archived), want)
              }
              if (m) {
                setTarget({ sessionId: m.sessionId, title: m.title, running: m.running === true, action })
              } else {
                setTarget({ sessionId: null, title: want, running: false, notFound: true, action })
              }
              setAcknowledged(false)
              setError(null)
              setBusy(false)
            })
            .catch(function () {
              setTarget({ sessionId: null, title: want, running: false, notFound: true, action })
              setAcknowledged(false)
              setError(null)
              setBusy(false)
            })
        }
        const onDelete = (e) => open('delete', e && e.detail ? e.detail : {})
        const onArchive = (e) => open('archive', e && e.detail ? e.detail : {})
        window.addEventListener(EVENT, onDelete)
        window.addEventListener(ARCHIVE_EVENT, onArchive)
        return () => {
          window.removeEventListener(EVENT, onDelete)
          window.removeEventListener(ARCHIVE_EVENT, onArchive)
        }
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
        const archive = target.action === 'archive'
        const operation = archive
          ? archiveSessionRequest(target.sessionId)
          : fetch('/__chameleon/session/delete', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: target.sessionId }),
            }).then(async (res) => {
              let data = {}
              try { data = await res.json() } catch { /* keep {} */ }
              if (!res.ok || !data.ok) {
                throw new Error(data.error || 'delete failed (HTTP ' + res.status + ')')
              }
              return { direct: false }
            })
        Promise.resolve(operation)
          .then((result) => {
            if (archive) {
              setTarget(null)
              // The official WorkspaceRuntime already installs the unary echo.
              // A compatibility endpoint needs a baseline refresh or reload.
              if (!result.direct) {
                const workspaces = __workspacesSvc
                if (workspaces && typeof workspaces.refresh === 'function') {
                  Promise.resolve(workspaces.refresh()).catch(() => {
                    if (typeof window !== 'undefined' && window.location) window.location.reload()
                  })
                } else if (typeof window !== 'undefined' && window.location) {
                  window.location.reload()
                }
              }
              return
            }
            // Deleted. Refresh the sidebar list in place — NO page reload —
            // and if the current session was deleted, open the first
            // remaining session so the user can keep working.
            const svc = __sessionsSvc
            const deletedCurrent = svc && svc.list
              ? svc.list.getSnapshot().current === target.sessionId
              : false
            setTarget(null)
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

      if (!target) return null

      const isArchive = target.action === 'archive'
      const name = target.notFound ? target.title || t('dialog.untitled') : (target.title || t('dialog.untitled'))
      const description = target.notFound
        ? t('dialog.notFoundDesc')
        : target.running
          ? t(isArchive ? 'dialog.archiveRunningDesc' : 'dialog.runningDesc')
          : t(isArchive ? 'dialog.archiveDesc' : 'dialog.deleteDesc')
      const dialogTitle = t(isArchive ? 'dialog.archiveTitle' : 'dialog.title')
      const confirmStyle = isArchive ? archiveBtnStyle : dangerBtnStyle

      return React.createElement(Modal, {
        open: true,
        onClose: close,
        title: dialogTitle,
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
            style: { ...confirmStyle, ...(busy || !acknowledged || !target.sessionId ? { opacity: 0.5, cursor: 'default' } : {}) },
          }, busy ? t(isArchive ? 'dialog.archiving' : 'dialog.confirming') : t(isArchive ? 'dialog.archiveConfirm' : 'dialog.confirm')),
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
          ? React.createElement('div', { key: 'warn', style: warnStyle }, t(isArchive ? 'dialog.archiveRunningWarn' : 'dialog.runningWarn'))
          : null,
        React.createElement('label', { key: 'ack', style: optStyle },
          React.createElement('input', {
            type: 'checkbox',
            checked: acknowledged,
            disabled: busy,
            onChange: (e) => setAcknowledged(e.target.checked),
          }),
          t(isArchive ? 'dialog.archiveAck' : 'dialog.ack')),
        busy ? React.createElement('div', { key: 'busy', style: statusStyle }, t(isArchive ? 'dialog.archiving' : 'dialog.deleting')) : null,
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

    function ArchiveSessionButton(props) {
      const { sessionId, useSessions } = props
      const t = (props && props.t) || __t
      useLocaleRevision()
      const sessions = useSessions ? useSessions((s) => s) : undefined
      const summary = sessions && sessions.byId ? sessions.byId[sessionId] : undefined
      const running = summary ? summary.running === true : false

      const openDialog = useCallback(() => {
        window.dispatchEvent(new CustomEvent(ARCHIVE_EVENT, {
          detail: {
            sessionId,
            title: summary && summary.title ? summary.title : null,
            running,
          },
        }))
      }, [sessionId, summary, running])

      return React.createElement('button', {
        type: 'button',
        title: running ? t('button.archiveTitleRunning') : t('button.archiveTitle'),
        'aria-label': t('button.archiveTitle'),
        style: archiveIconBtnStyle,
        onClick: openDialog,
      }, React.createElement(IconArchiveOutline20, { size: 16 }))
    }

    // --- sidebar session-row menu integration ----------------------------------
    // ui-workspace exposes no extension slot for row menus. This module injects
    // the delete item, intercepts a native archive item into the same confirmed
    // flow, and only adds an archive fallback after native menu content settles.
    // It never switches the selected conversation. Works in web and desktop.

    var TRASH_PATH = 'M14.4782 4.84067L14.2138 10.1152C14.1102 12.1872 14.067 13.0115 13.3866 13.9607C13.1044 14.3546 12.7498 14.6912 12.3424 14.9535C11.8239 15.2872 11.2415 15.4316 10.5585 15.4998C9.88727 15.5668 9.04946 15.5656 7.99998 15.5656C6.95051 15.5656 6.1127 15.5668 5.44142 15.4998C4.75851 15.4316 4.17602 15.2872 3.65753 14.9535C3.25012 14.6912 2.89559 14.3546 2.61332 13.9607C1.93296 13.0115 1.88979 12.1872 1.78619 10.1152L1.52179 4.84067L2.89006 4.77277L3.15343 10.0463C3.26221 12.2218 3.32452 12.6015 3.72646 13.1624C3.90825 13.4161 4.13686 13.6334 4.39927 13.8023C4.66204 13.9714 5.00263 14.0792 5.57825 14.1367C6.16562 14.1953 6.92298 14.1963 7.99998 14.1963C9.07699 14.1963 9.83434 14.1953 10.4217 14.1367C10.9973 14.0792 11.3379 13.9714 11.6007 13.8023C11.8631 13.6334 12.0917 13.4161 12.2735 13.1624C12.6755 12.6015 12.7378 12.2218 12.8465 10.0463L13.1099 4.77277L14.4782 4.84067ZM5.43011 6.22849H6.7994V11.3909H5.43011V6.22849ZM9.20056 6.22849H10.5699V11.3909H9.20056V6.22849ZM8.53597 0.434431C9.17976 0.434431 9.6522 0.426926 10.0966 0.571258C10.2357 0.616451 10.3717 0.672554 10.502 0.738948C10.9182 0.951107 11.2464 1.29099 11.7015 1.74612L12.4978 2.54136H15.3742V3.91169H0.625732V2.54136H3.50218L4.29845 1.74612C4.75358 1.29099 5.08174 0.951107 5.49801 0.738948C5.62831 0.672554 5.76425 0.616451 5.90334 0.571258C6.34776 0.426926 6.82021 0.434431 7.46399 0.434431H8.53597ZM7.46399 1.80476C6.73208 1.80476 6.51641 1.81187 6.32617 1.87369C6.25545 1.89667 6.18668 1.92533 6.12041 1.95907C5.96398 2.03878 5.82348 2.16253 5.44142 2.54136H10.5585C10.1765 2.16253 10.036 2.03878 9.87955 1.95907C9.81329 1.92533 9.74452 1.89667 9.6738 1.87369C9.48356 1.81187 9.26789 1.80476 8.53597 1.80476H7.46399Z'

    var ARCHIVE_PATH = 'M2 3.5C2 2.67 2.67 2 3.5 2h9c.83 0 1.5.67 1.5 1.5V5h-1.5V3.5h-9V5H2V3.5ZM2 6h12v6.5c0 .83-.67 1.5-1.5 1.5h-9C2.67 14 2 13.33 2 12.5V6Zm2 2v1.5h8V8H4Zm0 3v1.5h5V11H4Z'

    // Dispatch the row's exact id when the DOM exposes it; title matching remains
    // the fallback for older shells whose row markup carries no session id.
    function rowSessionTarget(row) {
      if (!row) return null
      var titleEl = row.querySelector('[class*=title]')
      var title = titleEl ? String(titleEl.innerText || '').trim() : ''
      if (!title) return null
      var sessionId = row.getAttribute('data-session-id') || (row.dataset && row.dataset.sessionId) || ''
      if (!sessionId) {
        var idEl = row.querySelector('[data-session-id]')
        if (idEl) sessionId = idEl.getAttribute('data-session-id') || ''
      }
      return { title, sessionId: String(sessionId || '').trim() || null }
    }

    function openSessionFlow(row, action) {
      var target = rowSessionTarget(row)
      if (!target) return
      var detail = { title: target.title }
      if (target.sessionId) detail.sessionId = target.sessionId
      window.dispatchEvent(new CustomEvent(action === 'archive' ? ARCHIVE_EVENT : EVENT, { detail }))
    }

    function isArchiveMenuEntry(element) {
      var text = normalizeTitle(element.innerText || element.getAttribute('aria-label') || '').toLowerCase()
      var attrs = ''
      for (var i = 0; i < element.attributes.length; i++) {
        attrs += ' ' + element.attributes[i].name + '=' + element.attributes[i].value
      }
      return text.indexOf('archive') >= 0 || text.indexOf('归档') >= 0 || /(^|[\s:_-])archive([\s:_-]|$)/i.test(attrs)
    }

    function findNativeArchiveItem(menu) {
      var entries = menu.querySelectorAll('[role=menuitem],button')
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].hasAttribute('data-chameleon-archive')) continue
        if (isArchiveMenuEntry(entries[i])) return entries[i]
      }
      return null
    }

    function bindNativeArchiveAction(menu, row) {
      var item = findNativeArchiveItem(menu)
      if (!item) return false
      if (item.getAttribute('data-chameleon-archive-intercepted') !== '1') {
        item.setAttribute('data-chameleon-archive-intercepted', '1')
        item.addEventListener('click', function (event) {
          event.preventDefault()
          event.stopImmediatePropagation()
          openSessionFlow(row, 'archive')
        }, true)
      }
      return true
    }

    function appendSidebarAction(menu, row, action) {
      var archive = action === 'archive'
      var item = document.createElement('button')
      item.type = 'button'
      item.setAttribute('role', 'menuitem')
      item.setAttribute(archive ? 'data-chameleon-archive' : 'data-chameleon-delete', '1')
      item.style.cssText = [
        'display:flex', 'align-items:center', 'gap:8px', 'width:100%',
        'padding:6px 12px', 'border:none', 'background:transparent',
        archive ? 'color:var(--dsw-alias-label-primary,inherit)' : 'color:var(--dsw-alias-state-error-primary,#e5484d)',
        'font:inherit', 'font-size:13px', 'line-height:20px',
        'text-align:left', 'border-radius:6px', 'cursor:pointer',
      ].join(';')
      var path = archive ? ARCHIVE_PATH : TRASH_PATH
      item.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex:none"><path d="' + path + '" fill="currentColor"/></svg><span></span>'
      item.querySelector('span').textContent = __t(archive ? 'menu.archive' : 'menu.delete')
      item.addEventListener('mouseenter', function () {
        item.style.background = 'var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))'
      })
      item.addEventListener('mouseleave', function () {
        item.style.background = 'transparent'
      })
      item.addEventListener('click', function () { openSessionFlow(row, action) })
      menu.appendChild(item)
    }

    function scheduleFallbackArchiveItem(menu, row) {
      if (menu.getAttribute('data-chameleon-archive-pending') === '1') return
      menu.setAttribute('data-chameleon-archive-pending', '1')
      setTimeout(function () {
        menu.removeAttribute('data-chameleon-archive-pending')
        if (!menu.isConnected) return
        var currentRow = findOpenSessionRow() || row
        if (bindNativeArchiveAction(menu, currentRow)) {
          var staleFallback = menu.querySelector('[data-chameleon-archive]')
          if (staleFallback) staleFallback.remove()
          return
        }
        if (!menu.querySelector('[data-chameleon-archive]')) appendSidebarAction(menu, currentRow, 'archive')
      }, 32)
    }

    function ensureSidebarMenuItems() {
      var menu = document.querySelector('[role=menu]')
      if (!menu) return
      var row = findOpenSessionRow()
      if (!row) return // not a session-row menu
      if (!menu.querySelector('[data-chameleon-delete]')) {
        if (!menu.querySelector('[data-chameleon-actions-separator]')) {
          var sep = document.createElement('div')
          sep.setAttribute('data-chameleon-actions-separator', '1')
          sep.style.cssText = 'height:1px;margin:4px 8px;background:var(--dsw-alias-border-l1,rgba(128,128,128,.2))'
          menu.appendChild(sep)
        }
        appendSidebarAction(menu, row, 'delete')
      }
      // Let React finish committing native menu children before deciding whether
      // a compatibility archive item is needed; native actions are intercepted
      // so they share the plugin's confirmation flow.
      if (bindNativeArchiveAction(menu, row)) {
        var staleFallback = menu.querySelector('[data-chameleon-archive]')
        if (staleFallback) staleFallback.remove()
      } else if (!menu.querySelector('[data-chameleon-archive]')) {
        scheduleFallbackArchiveItem(menu, row)
      }
    }

    function findOpenSessionRow() {
      var rows = document.querySelectorAll('[class*=sessionRow]')
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i].className || '').indexOf('menuOpen') >= 0) return rows[i]
      }
      return null
    }

    // Keep open DOM-injected labels in the active language. Native menu entries
    // are owned by DSH and are intentionally left untouched.
    function refreshSidebarActionLabels() {
      const deleteItems = document.querySelectorAll('[data-chameleon-delete]')
      for (let i = 0; i < deleteItems.length; i++) {
        const span = deleteItems[i].querySelector('span')
        if (span) span.textContent = __t('menu.delete')
      }
      const archiveItems = document.querySelectorAll('[data-chameleon-archive]')
      for (let i = 0; i < archiveItems.length; i++) {
        const span = archiveItems[i].querySelector('span')
        if (span) span.textContent = __t('menu.archive')
      }
    }

    function installSidebarMenuActions() {
      if (window.__chameleonSidebarActionsInstalledV2) return
      window.__chameleonSidebarActionsInstalledV2 = true
      try { ensureSidebarMenuItems() } catch (e) { /* never crash the UI */ }
      var observer = new MutationObserver(function () {
        try { ensureSidebarMenuItems() } catch (e) { /* never crash the UI */ }
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
      // WorkspaceRuntime owns the official archive RPC and archive-set mirror.
      __workspacesSvc = ctx.get('workspaces')
      if (!__workspacesSvc) {
        ctx.inject(['workspaces'], (sub) => {
          __workspacesSvc = sub.workspaces
        })
      }
      // The locale service drives the zh/en copy. Absent a deferred inject
      // (minimal compositions), `__t` falls back to the built-in dicts.
      adoptLocale(ctx.get('locale'), ctx)
      if (!__locale) {
        ctx.inject(['locale'], (sub) => {
          adoptLocale(sub.locale, ctx)
          refreshSidebarActionLabels()
        })
      }
      ctx.on('locale/change', refreshSidebarActionLabels)
      // `locale: NS` gives the registered components the `t` seat (the
      // renderer re-derives it on every locale switch); without the service
      // the components fall back to `__t` + useLocaleRevision().
      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: ROW_ID,
        order: 30,
        ...(__locale ? { locale: NS } : {}),
      }, DeleteSessionButton))
      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: ARCHIVE_ROW_ID,
        order: 29,
        ...(__locale ? { locale: NS } : {}),
      }, ArchiveSessionButton))
      ctx.slots.inject(MANAGER_SLOT, () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: MANAGER_ROW_ID,
        order: 20,
        ...(__locale ? { locale: NS } : {}),
      }, ArchiveManagerButton))
      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: 'shell.overlay',
        id: DIALOG_ID,
        order: 100,
        ...(__locale ? { locale: NS } : {}),
      }, DeleteSessionDialog))
      installSidebarMenuActions()
    }

    // The loader gates apply() until the declared services exist.
    return { apply, inject: ['slots'] }
  },
})
