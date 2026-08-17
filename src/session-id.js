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
// parent-directory reference. It also rejects a trailing `.` (invalid or
// normalized away on Windows, where `a.` would target the dir `a`) and Windows
// reserved device names (CON/PRN/AUX/NUL/COMn/LPTn), which cannot be used as
// directory names there.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Conservative slug: alphanumeric first char, then [A-Za-z0-9._-], and the LAST
// char must be alphanumeric, `_` or `-` (never a dot). Length 1..128.
const SLUG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/
// Windows reserved device names, case-insensitive, with or without a trailing
// extension (e.g. `NUL`, `con.txt`, `COM1.foo`).
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i
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
  if (WINDOWS_RESERVED_RE.test(raw)) {
    return false
  }
  return UUID_RE.test(raw) || SLUG_RE.test(raw)
}

// Session ids may appear in two spellings in different stores: the raw id
// (`<uuid>` or `<custom-slug>`) and the prefixed form (`session-<id>`).  The
// on-disk JSONL backend encodes the exact session id, while older/workspace/
// projcache rows can carry either spelling.  Return every unique spelling we
// should clean up.
//
// NOTE on the `session-` prefix ambiguity: any input starting with `session-`
// is treated as the prefixed spelling, and its bare remainder as the alternate
// spelling. This is correct because DSH mints canonical ids WITH the
// `session-` prefix; a raw id that itself began with `session-` is not
// separately supported (see test 'session-foo 歧义').
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
