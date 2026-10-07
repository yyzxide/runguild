export function routeRequest(request) {
  if (request.method === 'GET' && request.path === '/health') {
    return { status: 200, body: { status: 'ok' } }
  }
  return { status: 404, body: { error: { code: 'not_found' } } }
}
