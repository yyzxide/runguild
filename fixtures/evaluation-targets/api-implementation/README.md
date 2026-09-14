# API implementation target

Implement `POST /tasks` in the pure `routeRequest(request)` function in
`src/router.mjs`; preserve the existing health and not-found behavior.

Contract:

- accept an object body with a non-empty trimmed `title`;
- accept `priority` values `low`, `normal`, or `high`, defaulting to `normal`;
- reject invalid titles with status 400 and code `invalid_title`;
- reject invalid priorities with status 400 and code `invalid_priority`;
- return status 201 with `{ task: { id, title, priority } }`;
- derive `id` deterministically as `task_` plus the lowercase title with each
  non-alphanumeric run replaced by one hyphen and edge hyphens removed.

Do not edit `test/acceptance.test.mjs`; it is protected acceptance evidence.
