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

test('rejects trailing-dot ids (Windows normalization would target another dir)', () => {
  for (const bad of ['a.', 'abc.', 'a..', 'session-a.', 'session-abc.']) {
    assert.equal(isValidSessionId(bad), false, `should reject ${JSON.stringify(bad)}`)
  }
  // Dots inside the slug are still fine.
  assert.equal(isValidSessionId('a.b'), true)
  assert.equal(isValidSessionId('session-a.b_c-1'), true)
})

test('rejects Windows reserved device names', () => {
  for (const bad of [
    'con', 'CON', 'prn', 'aux', 'nul', 'NUL',
    'com1', 'COM9', 'lpt1', 'LPT9', 'com0',
    'con.txt', 'nul.', 'COM1.foo',
    'session-nul', 'session-con.txt',
  ]) {
    assert.equal(isValidSessionId(bad), false, `should reject ${JSON.stringify(bad)}`)
  }
  // `foo.con` is a plain filename on Windows — not reserved.
  assert.equal(isValidSessionId('foo.con'), true)
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

test('sessionIdVariants documents the session- prefix ambiguity', () => {
  // DSH mints canonical ids WITH the `session-` prefix, so `session-foo` is
  // treated as the prefixed spelling of canonical `foo`, and both spellings
  // are expanded. A distinct raw id that itself begins with `session-` is not
  // separately supported; this test pins the intended behavior.
  assert.equal(isValidSessionId('session-foo'), true)
  assert.deepEqual(
    new Set(sessionIdVariants('session-foo')),
    new Set(['session-foo', 'foo']),
  )
  // The prefixed spelling of canonical `session-foo` is `session-session-foo`.
  assert.deepEqual(
    new Set(sessionIdVariants('session-session-foo')),
    new Set(['session-session-foo', 'session-foo']),
  )
})
