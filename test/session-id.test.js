import test from 'node:test'
import assert from 'node:assert/strict'
import { isValidSessionId, sessionIdVariants } from '../src/session-id.js'

const UUID = '550e8400-e29b-41d4-a716-446655440000'

test('accepts legacy UUIDs with and without session- prefix', () => {
  assert.equal(isValidSessionId(UUID), true)
  assert.equal(isValidSessionId(`session-${UUID}`), true)
})

test('accepts DSH custom session ids', () => {
  assert.equal(isValidSessionId('aux-open-anc-1786848712'), true)
  assert.equal(isValidSessionId('session-aux-open-anc-1786848712'), true)
  assert.equal(isValidSessionId('my.session_1'), true)
  assert.equal(isValidSessionId('session-my.session_1'), true)
})

test('rejects path traversal and filesystem separators', () => {
  for (const bad of [
    '.',
    '..',
    'session-.',
    'session-..',
    '../etc/passwd',
    'session-../etc/passwd',
    'session-/',
    'session-/../etc/passwd',
    'session-a/../b',
    'a/b',
    'a\\b',
    'a:b',
    'a*b',
    'a?b',
    'a"b',
    "a'b",
    'a<b',
    'a>b',
    'a|b',
    'a\u0000b',
    'a\u0001b',
  ]) {
    assert.equal(isValidSessionId(bad), false, `should reject ${JSON.stringify(bad)}`)
  }
})

test('rejects empty, prefix-only, and overlong ids', () => {
  assert.equal(isValidSessionId(''), false)
  assert.equal(isValidSessionId('session-'), false)
  assert.equal(isValidSessionId('a'.repeat(129)), false)
  assert.equal(isValidSessionId(`session-${'a'.repeat(129)}`), false) // raw 129 > 128
  assert.equal(isValidSessionId('a'.repeat(128)), true)
  assert.equal(isValidSessionId(`session-${'a'.repeat(128)}`), true) // full 136, raw 128
})

test('sessionIdVariants expands both spellings for custom ids', () => {
  assert.deepEqual(
    new Set(sessionIdVariants('aux-open-anc-1786848712')),
    new Set(['aux-open-anc-1786848712', 'session-aux-open-anc-1786848712']),
  )
  assert.deepEqual(
    new Set(sessionIdVariants('session-aux-open-anc-1786848712')),
    new Set(['session-aux-open-anc-1786848712', 'aux-open-anc-1786848712']),
  )
})

test('sessionIdVariants keeps invalid ids unchanged', () => {
  assert.deepEqual(sessionIdVariants('../etc/passwd'), ['../etc/passwd'])
  assert.deepEqual(sessionIdVariants('session-..'), ['session-..'])
})
