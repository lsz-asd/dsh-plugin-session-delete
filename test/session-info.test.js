import test from 'node:test'
import assert from 'node:assert/strict'
import {
  REACT_FIBER_KEY_PREFIX,
  fiberFromNode,
  sessionInfoFromFiber,
  sessionInfoFromNode,
} from '../src/session-info.js'

test('fiberFromNode returns null for null/non-fiber nodes', () => {
  assert.equal(fiberFromNode(null), null)
  assert.equal(fiberFromNode({ className: 'x' }), null)
})

test('fiberFromNode finds the React-18 fiber key', () => {
  const fiber = { memoizedProps: {} }
  const node = { [`${REACT_FIBER_KEY_PREFIX}abc`]: fiber, className: 'sessionRow' }
  assert.equal(fiberFromNode(node), fiber)
})

test('sessionInfoFromNode returns null without a fiber key', () => {
  assert.equal(sessionInfoFromNode(null), null)
  assert.equal(sessionInfoFromNode({ className: 'x' }), null)
})

test('sessionInfoFromNode reads id and running from the row node', () => {
  const node = {
    [`${REACT_FIBER_KEY_PREFIX}x`]: {
      memoizedProps: { className: 'sessionRow' },
      return: {
        memoizedProps: { className: 'root' },
        return: {
          memoizedProps: { node: { id: 'session-123', running: true, blank: false } },
          return: null,
        },
      },
    },
  }
  assert.deepEqual(sessionInfoFromNode(node), { sessionId: 'session-123', running: true })
})

test('sessionInfoFromFiber treats missing/truthy running as false', () => {
  const fiber = { memoizedProps: { node: { id: 'a', running: undefined, blank: false } } }
  assert.deepEqual(sessionInfoFromFiber(fiber), { sessionId: 'a', running: false })
})

test('sessionInfoFromFiber skips non-string node.id', () => {
  const fiber = { memoizedProps: { node: { id: 42, running: true, blank: false } }, return: null }
  assert.equal(sessionInfoFromFiber(fiber), null)
})

test('sessionInfoFromFiber does not trust a node without boolean blank', () => {
  const fiber = { memoizedProps: { node: { id: 'generic-id', running: true } }, return: null }
  assert.equal(sessionInfoFromFiber(fiber), null)
})

test('sessionInfoFromFiber walks a deep chain until it finds a session node', () => {
  let child = { memoizedProps: { className: 'row' } }
  const head = child
  for (let i = 0; i < 10; i++) {
    child.return = { memoizedProps: { className: `level-${i}` } }
    child = child.return
  }
  child.return = { memoizedProps: { node: { id: 'deep-id', running: true, blank: false } } }
  assert.deepEqual(sessionInfoFromFiber(head), { sessionId: 'deep-id', running: true })
})

test('sessionInfoFromFiber respects maxDepth and does not loop forever', () => {
  let child = { memoizedProps: {} }
  const head = child
  for (let i = 0; i < 40; i++) {
    child.return = { memoizedProps: {} }
    child = child.return
  }
  child.return = { memoizedProps: { node: { id: 'late', running: false, blank: false } } }
  assert.equal(sessionInfoFromFiber(head, 32), null)
  assert.deepEqual(sessionInfoFromFiber(head, 64), { sessionId: 'late', running: false })
})
