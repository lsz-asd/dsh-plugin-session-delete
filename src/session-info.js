// Session-info extraction from a React-18 DOM row, kept as a unit-testable
// canonical copy of the logic inlined in src/client.js's sessionInfoFromRow.
//
// DSH's ui-workspace SessionNodeItem does not render the session id into the
// DOM, but the row's host div carries React's internal fiber handle
// (`__reactFiber$...`). Walking up the fiber chain reaches SessionNodeItem,
// whose memoizedProps.node is the session node ({ id, running, ... }).
//
// This module is NOT imported by the browser bundle (client.js is a single
// self-contained module with no relative imports); it exists so the traversal
// logic has unit tests. Keep it in sync with sessionInfoFromRow in client.js.

export const REACT_FIBER_KEY_PREFIX = '__reactFiber$'

// Find React's fiber handle on a DOM node. Returns the fiber or null when the
// node is null or carries no React-18 fiber key.
export function fiberFromNode(node) {
  if (!node) return null
  const keys = Object.keys(node)
  for (const key of keys) {
    if (key.startsWith(REACT_FIBER_KEY_PREFIX)) return node[key]
  }
  return null
}

// Walk up a fiber chain looking for the SessionNodeItem component whose
// `memoizedProps.node` carries the session id/running. Returns
// { sessionId, running } or null. A node is accepted only when it looks like
// a session node (`id` string and boolean `blank`), so a generic wrapper with
// a coincidental `node.id` is not trusted. `maxDepth` bounds the walk so a
// malformed chain cannot loop forever.
export function sessionInfoFromFiber(fiber, maxDepth = 32) {
  for (let depth = 0; fiber && depth < maxDepth; depth++, fiber = fiber.return) {
    const props = fiber.memoizedProps
    if (props && props.node && typeof props.node.id === 'string' && props.node.id && typeof props.node.blank === 'boolean') {
      return { sessionId: props.node.id, running: props.node.running === true }
    }
  }
  return null
}

// Convenience wrapper: read the fiber off a DOM-like node then walk it.
export function sessionInfoFromNode(node, maxDepth = 32) {
  return sessionInfoFromFiber(fiberFromNode(node), maxDepth)
}
