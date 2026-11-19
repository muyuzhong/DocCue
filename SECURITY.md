# Security Policy

## Supported Versions

DocCue is currently pre-1.0 (`0.1.x`). Security fixes are applied to the latest `0.1.x` release on `main`.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report vulnerabilities privately via [GitHub Security Advisories](https://github.com/muyuzhong/DocCue/security/advisories/new). Include:

- A description of the issue and potential impact
- Minimal reproduction steps or a proof of concept
- The affected package(s) and version

We aim to acknowledge reports within 72 hours and work with you on a fix and coordinated disclosure.

## Security Model & Integrator Responsibilities

DocCue is designed as an in-app guidance library with an explicit trust boundary:

1. **Read-only guidance**: DocCue points at controls on the page; it never clicks buttons, fills forms, or executes actions on the user's behalf.
2. **Untrusted request payloads**: Because the backend is stateless, the browser sends the full conversation (`user`, `model`, and `guide_result` items), screen snapshot, recorded actions, and client-side `user` attributes on every request. Treat the entire request body as untrusted user input:
   - Never rely on browser-supplied `user` attributes for access control or privileged behavior. Pass trusted attributes (role, plan, tenant) via `createHandler({ user })` from your server-side session; these always replace what the browser sent.
   - Protect your mounted DocCue endpoint with your own **authentication** and **rate limiting**. Anyone who can reach `POST {basePath}/turn` can trigger calls to your configured LLM.
   - Keep custom backend `tools` read-only and scoped to the authenticated user.
3. **Client-side data collection**:
   - The bridge records actions locally in `sessionStorage` and uploads them only when the user asks a question.
   - `<input type="password">` values are never collected (only marked as filled).
   - Mark custom chat UIs and sensitive DOM subtrees with `data-cue-ignore` to exclude them from recording and snapshots.
   - Failed HTTP request bodies captured when `captureNetwork: true` (the default) may include server error messages; disable with `captureNetwork: false` if your API error responses can contain sensitive data.
4. **Safe output rendering**: Both the built-in chat panel and guide bubbles escape all HTML before rendering a small Markdown subset. Only `http:` and `https:` links are rendered, always opening in a new tab with `rel="noopener noreferrer nofollow"`.
