/**
 * Odin's OAuth token exchange.
 *
 * Slack and Notion both require a client secret at the token exchange and
 * neither supports PKCE, so a distributed desktop app has nowhere safe to keep
 * one — anyone with the bundle can grep it out. This Worker holds the secrets
 * instead: it is the registered redirect URI, it performs the exchange, and the
 * app never sees a secret.
 *
 * The token is not put in the redirect URL. A URL travels through browser
 * history and through this Worker's own response headers, so instead the token
 * is parked in KV under a single-use handoff id, and the app collects it over
 * TLS with a POST. The id is useless once spent.
 *
 *   provider consent  →  GET /<provider>/callback?code&state
 *                        (exchange happens here)
 *                     →  302 odin://oauth/<provider>?handoff=…&state=…
 *   app                →  POST /handoff  { id }
 *                     →  { token }           (id deleted)
 */

export interface Env {
	HANDOFF: KVNamespace;
	SLACK_CLIENT_ID: string;
	SLACK_CLIENT_SECRET: string;
	NOTION_CLIENT_ID: string;
	NOTION_CLIENT_SECRET: string;
	/** Deep-link scheme to hand back to. Overridable for a dev build. */
	APP_SCHEME?: string;
}

/** Long enough to click through consent, short enough to not linger. */
const HANDOFF_TTL_SECONDS = 600;

type Provider = "slack" | "notion";

function scheme(env: Env): string {
	return env.APP_SCHEME || "odin";
}

/** A plain page for humans who land here without a code. */
function page(title: string, detail: string, status = 200): Response {
	return new Response(
		`<!doctype html><meta charset="utf-8"><title>${title}</title>` +
			`<body style="font:14px/1.5 -apple-system,sans-serif;background:#0a0a0c;color:#f5f5f7;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center">` +
			`<div><p>${title}</p><p style="color:#8d8d99">${detail}</p></div>`,
		{ status, headers: { "content-type": "text/html;charset=utf-8" } },
	);
}

async function exchangeSlack(
	env: Env,
	code: string,
	redirectUri: string,
): Promise<{ token?: string; identity?: string; error?: string }> {
	const res = await fetch("https://slack.com/api/oauth.v2.access", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: env.SLACK_CLIENT_ID,
			client_secret: env.SLACK_CLIENT_SECRET,
			code,
			redirect_uri: redirectUri,
		}),
	});
	const json = (await res.json()) as {
		ok?: boolean;
		error?: string;
		team?: { name?: string };
		authed_user?: { access_token?: string };
	};
	if (!json.ok) return { error: json.error ?? `HTTP ${res.status}` };
	const token = json.authed_user?.access_token;
	// A bot-only install has no user token, and the reactions feed needs one.
	if (!token) return { error: "no_user_token" };
	return { token, identity: json.team?.name };
}

async function exchangeNotion(
	env: Env,
	code: string,
	redirectUri: string,
): Promise<{ token?: string; identity?: string; error?: string }> {
	const basic = btoa(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`);
	const res = await fetch("https://api.notion.com/v1/oauth/token", {
		method: "POST",
		headers: {
			authorization: `Basic ${basic}`,
			"content-type": "application/json",
			"notion-version": "2022-06-28",
		},
		body: JSON.stringify({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
		}),
	});
	const json = (await res.json()) as {
		access_token?: string;
		refresh_token?: string;
		workspace_name?: string;
		error?: string;
		error_description?: string;
	};
	if (!json.access_token) {
		return { error: json.error_description ?? json.error ?? `HTTP ${res.status}` };
	}
	// Notion's access tokens expire, so the refresh token travels with it.
	return {
		token: JSON.stringify({
			access_token: json.access_token,
			refresh_token: json.refresh_token,
		}),
		identity: json.workspace_name,
	};
}

async function handleCallback(
	provider: Provider,
	request: Request,
	env: Env,
): Promise<Response> {
	const url = new URL(request.url);
	const state = url.searchParams.get("state");
	const code = url.searchParams.get("code");
	const denied = url.searchParams.get("error");

	// Bounce failures back to the app too, so it can stop waiting instead of
	// polling until its own timeout.
	const back = (params: Record<string, string>) => {
		const target = new URL(`${scheme(env)}://oauth/${provider}`);
		for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
		if (state) target.searchParams.set("state", state);
		return Response.redirect(target.toString(), 302);
	};

	if (denied) return back({ error: denied });
	if (!code || !state) {
		return page(
			"Nothing to hand over",
			"This page is Odin's OAuth callback — open Odin and press Connect.",
			400,
		);
	}

	// Must match the authorize call exactly, which means this Worker's own URL.
	const redirectUri = `${url.origin}${url.pathname}`;
	const result =
		provider === "slack"
			? await exchangeSlack(env, code, redirectUri)
			: await exchangeNotion(env, code, redirectUri);

	if (!result.token) return back({ error: result.error ?? "exchange_failed" });

	const id = crypto.randomUUID();
	await env.HANDOFF.put(
		id,
		JSON.stringify({ token: result.token, identity: result.identity ?? null }),
		{ expirationTtl: HANDOFF_TTL_SECONDS },
	);
	return back({ handoff: id });
}

/** Spend a handoff id. Single use: the entry is deleted before responding. */
async function handleHandoff(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") {
		return Response.json({ error: "method_not_allowed" }, { status: 405 });
	}
	let id: unknown;
	try {
		({ id } = (await request.json()) as { id?: unknown });
	} catch {
		return Response.json({ error: "bad_request" }, { status: 400 });
	}
	if (typeof id !== "string" || id.length === 0) {
		return Response.json({ error: "bad_request" }, { status: 400 });
	}
	const stored = await env.HANDOFF.get(id);
	if (!stored) {
		// Already spent, expired, or never existed — indistinguishable on purpose.
		return Response.json({ error: "unknown_handoff" }, { status: 404 });
	}
	await env.HANDOFF.delete(id);
	return new Response(stored, {
		headers: { "content-type": "application/json" },
	});
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === "/slack/callback")
			return handleCallback("slack", request, env);
		if (pathname === "/notion/callback")
			return handleCallback("notion", request, env);
		if (pathname === "/handoff") return handleHandoff(request, env);
		return page("Odin auth", "Nothing to see here.", 404);
	},
} satisfies ExportedHandler<Env>;
