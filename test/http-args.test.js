import test from 'node:test'
import assert from 'node:assert/strict'
import { parseJsonObjectBody } from '../src/http-args.js'

test('empty / missing body -> {}', () => {
  assert.deepEqual(parseJsonObjectBody(''), {})
  assert.deepEqual(parseJsonObjectBody(null), {})
  assert.deepEqual(parseJsonObjectBody(undefined), {})
})

test('JSON null -> {} (no crash)', () => {
  assert.deepEqual(parseJsonObjectBody('null'), {})
})

test('JSON primitives and arrays -> {}', () => {
  assert.deepEqual(parseJsonObjectBody('123'), {})
  assert.deepEqual(parseJsonObjectBody('"str"'), {})
  assert.deepEqual(parseJsonObjectBody('true'), {})
  assert.deepEqual(parseJsonObjectBody('[1,2]'), {})
})

test('JSON object passes through', () => {
  assert.deepEqual(parseJsonObjectBody('{"sessionId":"x"}'), { sessionId: 'x' })
})

test('invalid JSON throws (handler maps it to 400)', () => {
  assert.throws(() => parseJsonObjectBody('{oops'))
  assert.throws(() => parseJsonObjectBody('junk'))
})
