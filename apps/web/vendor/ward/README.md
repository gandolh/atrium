# ward-auth 0.2.0 (vendored)

This directory is a built copy of ward-auth, the shared library for the
estate's apps: local accounts, and "Sign in with Ward". It is generated: do not edit these files. To upgrade,
build a newer version and copy it over this one, then follow the upgrade notes.

- **Version:** 0.2.0
- **Source:** https://github.com/gandolh/ward-auth, folder `shared-library/`
- **Upgrade notes:** https://github.com/gandolh/ward-auth/blob/main/shared-library/CHANGELOG.md

| File | What it is |
|---|---|
| `ward-auth.js` | Server bundle: accounts, sessions, lockout, SQLite store, Sign in with Ward, Fastify plugin |
| `ward-auth.d.ts` | Its types |
| `ward-auth-react.js` | Browser bundle: unstyled React hooks |
| `ward-auth-react.d.ts` | Its types |
| `LICENSE` | MIT |

Import the bundles by relative path. Fastify and React come from the app's own
dependencies; nothing here needs installing.
