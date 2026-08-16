// Session-id validation shared by the delete plugin.
//
// The plugin deletes sessions from ~/.dsh/sessions and from several storage
// domains, so a session id is used as a file/directory/key component.  It must
// never be allowed to act as a path traversal token.  We accept:
//
//   * legacy UUID ids, with or without the `session-` prefix;
//   * DSH custom ids (e.g. `aux-open-anc-1786848712`), with or without the
//     `session-` prefix, using conservative slug rules (raw id <= 128 chars;
//     with the 8-char prefix the full id may be up to 136 chars).
//
// The slug rule requires an alphanumeric first character, so a bare `.` or
// `..` (or a `session-` prefixed `.`/`..`) is rejected before it can become a
// parent-directory reference.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const PREFIX = 'session-'

export function isValidSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 136) {
    return false
  }
  const raw = sessionId.startsWith(PREFIX) ? sessionId.slice(PREFIX.length) : sessionId
  // Defense in depth: never allow the raw id to become `.` or `..`, which
  // would otherwise be interpreted as a parent-directory reference.
  if (raw === '' || raw === '.' || raw === '..') {
    return false
  }
  return UUID_RE.test(raw) || SLUG_RE.test(raw)
}

// Session ids may appear in two spellings in different stores: the raw id
// (`<uuid>` or `<custom-slug>`) and the prefixed form (`session-<id>`).  The
// on-disk JSONL backend encodes the exact session id, while older/workspace/
// projcache rows can carry either spelling.  Return every unique spelling we
// should clean up.
export function sessionIdVariants(sessionId) {
  const variants = new Set([sessionId])
  if (sessionId.startsWith(PREFIX)) {
    const raw = sessionId.slice(PREFIX.length)
    if (isValidSessionId(raw)) variants.add(raw)
  } else if (isValidSessionId(sessionId)) {
    variants.add(`${PREFIX}${sessionId}`)
  }
  return [...variants]
}
