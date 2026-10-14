# Tianshu Connect WorkBuddy

A native Tianshu plugin that connects local WorkBuddy CN and WorkBuddy AI accounts to Tianshu's model picker.

It runs inside Tianshu, exposes authenticated loopback OpenAI-compatible endpoints, and provides plugin tools for browser sign-in, account and credit status, model multipliers, catalog refresh, provider registration, and smoke tests.

Install from a Tianshu session:

```text
/plugin install https://github.com/skyjjgw/tianshu-connect-workbuddy
```

If GitHub is unreachable from your network, prepend a proxy prefix:

```text
/plugin install https://ghfast.top/https://github.com/skyjjgw/tianshu-connect-workbuddy
```

Verified proxies (2026-10-14, all include `lib/` and match GitHub HEAD):
`ghfast.top`, `ghproxy.net`, `gh.llkk.cc` — same
`https://<proxy>/https://github.com/<owner>/<repo>` form. These are public
services: the same address can work today and return 403 tomorrow. Switch to
another one if it fails. Known bad: `gh-proxy.com` (server-side 403),
`hub.fastgit.xyz` (returns an empty repo, which looks like a successful clone).

For a fully offline install, download or copy the repo locally and point Tianshu at
the directory:

```text
/plugin install D:\path\to\tianshu-connect-workbuddy
```

The build output `lib/` is committed, so no network access or build step is needed.

Open a new session, then run `/workbuddy` or ask Tianshu to set up WorkBuddy. See README.md for the full Chinese guide and security notes.
