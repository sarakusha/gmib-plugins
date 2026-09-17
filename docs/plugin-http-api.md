# Plugin HTTP API convention

Plugin HTTP routes are opt-in and plugin-owned. A plugin may expose a small authenticated
`GET /openapi.json` route that returns an OpenAPI 3.1 document for its own routes and DTOs. The host
serves that document through the existing generic plugin dispatch under
`/api/plugins/<plugin-id>/openapi.json` and applies the route's declared access policy.

This is a convention, not a required manifest field or SDK. Plugins may choose different paths,
request formats, response shapes, and schemas; `/settings` is not a universal configuration route.
New plugin APIs do not require a GMIB host release when the existing Plugin API permissions and
generic HTTP route mechanism are sufficient. Unknown plugins or plugins without this optional route
return the host's normal not-found response.

The schema should describe only public plugin routes and should not expose private storage, secrets,
implementation details, or local-only routes. Keep it inside the plugin archive, usually at
`public/openapi.json`, and serve it from the backend with `access: 'authenticated'` when it documents
remote routes.
