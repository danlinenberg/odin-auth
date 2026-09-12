# odin-auth

The OAuth redirect page for [Odin](https://github.com/danlinenberg/odin), a
desktop app.

Slack requires an HTTPS redirect URL and won't redirect to a custom scheme, so
a desktop app can't receive its OAuth callback directly. `slack.html` is the
whole workaround: it forwards the query string to `odin://oauth/slack` and does
nothing else. `notion.html`, `jira.html` and `google.html` are the same page for
Notion, Jira and Gmail — a Google *web* OAuth client won't redirect to a custom
scheme either.

There is no tracking, no network call, and no secret here — just one
`location.replace`. The auth code it forwards is single-use and only meaningful
to the app holding the matching `state`.
