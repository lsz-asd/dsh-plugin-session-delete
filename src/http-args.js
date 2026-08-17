// Parse a JSON HTTP request body into a plain object for delete-args, failing
// safely on null/array/primitive JSON values (they are not objects).
//
// The delete endpoint accepts JSON bodies. `JSON.parse('null')` returns `null`
// (not an object), and older code then dereferenced `args.sessionId` and threw
// an uncaught TypeError outside the try/catch. This guard turns any non-object
// body into `{}` so the handler answers "sessionId required" instead of
// crashing. Invalid JSON still throws (JSON.parse), and the caller maps that
// to a 400 "bad json body".
export function parseJsonObjectBody(body) {
  if (!body) return {}
  const parsed = JSON.parse(body)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  return {}
}
