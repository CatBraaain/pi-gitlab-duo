import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type OAuthCredential,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ANTHROPIC_PROXY_URL, OPENAI_PROXY_URL, catalogRefresher, oauthCatalogOwner } from "./catalog.ts";
import registerGitLabDuo from "./index.ts";

const oauth: OAuthCredential = {
	type: "oauth",
	access: "gitlab-test-access",
	refresh: "gitlab-test-refresh",
	expires: 99,
};
const fallback = [
	{
		id: "gpt-5-codex",
		name: "GPT-5 Codex",
		baseUrl: OPENAI_PROXY_URL,
		input: ["text" as const],
		reasoning: true,
		contextWindow: 128_000,
		maxTokens: 16_384,
		cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
	},
];

const definitions = `
models:
  - gitlab_identifier: gpt_next
    proxy_provider: openai
    supports_vision: true
    max_context_tokens: 1_000_000
    effort_levels: &gpt_effort [low, high, xhigh]
    params:
      model: gpt-next-2029-02-15
      max_tokens: 128_000
  - gitlab_identifier: claude_next
    proxy_provider: anthropic
    name: Claude Next
    supports_vision: false
    effort_levels: [low, high, max]
    params:
      model: claude-next-12
  - gitlab_identifier: another_new_gpt
    proxy_provider: openai
    effort_levels: *gpt_effort
    params:
      model: gpt-next-mini
      max_tokens: 400_000
  - gitlab_identifier: claude_without_reasoning
    proxy_provider: anthropic
    max_context_tokens: 16_384
    params:
      model: claude-basic
  - gitlab_identifier: internal_alias
    proxy_provider: anthropic
    params:
      model: claude-flow
  - gitlab_identifier: restricted_flow
    params:
      model: claude-flow
  - gitlab_identifier: unsupported
    proxy_provider: vertex-ai
    params:
      model: unsupported
  - gitlab_identifier: no_wire_id
    proxy_provider: openai
`;

const restrictions = `
restricted_models:
  - identifier: restricted_flow
    feature_settings: [example_flow]
`;

const duoGroupId = "gid://gitlab/Group/42";

const offered = [
	{ ref: "gpt_next", name: "GPT Next" },
	{ ref: "claude_next" },
	{ ref: "another_new_gpt" },
	{ ref: "claude_without_reasoning" },
	{ ref: "internal_alias" },
	{ ref: "unsupported" },
	{ ref: "no_wire_id" },
	{ ref: "graphql_only_ref" },
	{ name: "Missing ref" },
];

async function setup(t: TestContext) {
	const directory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "pi-gitlab-duo-catalog-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "catalog.json");
	const context: RefreshModelsContext = {
		credential: oauth,
		allowNetwork: true,
		signal: new AbortController().signal,
		publish: async () => true,
	};
	const refresh = catalogRefresher(path, fallback);
	return { path, context, refresh };
}

function mockCatalog(
	t: TestContext,
	options: {
		response?: Response;
		namespaceResponse?: Response;
		pinned?: unknown;
		models?: unknown[];
		yaml?: string;
		gatewayStatus?: number;
	} = {},
) {
	return t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
		const url = new URL(input);
		if (url.pathname === "/api/graphql") {
			assert.equal(url.origin, "https://gitlab.com");
			assert.equal(init?.method, "POST");
			assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${oauth.access}`);
			const { query, variables } = JSON.parse(String(init?.body));
			if (query.includes("duoDefaultNamespace")) {
				return (
					options.namespaceResponse ??
					Response.json({
						data: { currentUser: { userPreferences: { duoDefaultNamespace: { id: duoGroupId } } } },
					})
				);
			}
			if (
				!/aiChatAvailableModels\(rootNamespaceId: \$rootNamespaceId\)/.test(query) ||
				variables?.rootNamespaceId !== duoGroupId
			) {
				return Response.json({
					data: { aiChatAvailableModels: null },
					errors: [
						{
							message:
								"The resource that you are attempting to access does not exist or you don't have permission to perform this action",
						},
					],
				});
			}
			return (
				options.response ??
				Response.json({
					data: {
						aiChatAvailableModels: {
							selectableModels: options.models ?? offered,
							defaultModel: null,
							pinnedModel: options.pinned ?? null,
						},
					},
				})
			);
		}
		assert.equal(new Headers(init?.headers).has("Authorization"), false);
		assert.equal(url.origin, "https://gitlab.com");
		if (url.pathname.endsWith("/models.yml")) {
			return new Response(options.yaml ?? definitions, { status: options.gatewayStatus ?? 200 });
		}
		if (url.pathname.endsWith("/model_restrictions.yml")) return new Response(restrictions);
		throw new Error(`Unexpected request: ${url}`);
	});
}

test("discovers the default Duo group before fetching the scoped model list", async (t) => {
	const { context, refresh } = await setup(t);
	const fetch = mockCatalog(t, { models: [{ ref: "gpt_next" }] });
	assert.deepEqual(
		(await refresh(context)).map((model) => model.id),
		["gpt-next-2029-02-15"],
	);
	const queries = fetch.mock.calls
		.filter(({ arguments: [url] }) => url === "https://gitlab.com/api/graphql")
		.map(({ arguments: [, init] }) => JSON.parse(String(init?.body)));
	assert.equal(queries.length, 2);
	assert.match(queries[0].query, /currentUser\s*\{\s*userPreferences\s*\{\s*duoDefaultNamespace/);
	assert.deepEqual(queries[1].variables, { rootNamespaceId: duoGroupId });
});

test("does not query a model list without a default Duo group", async (t) => {
	const { context, refresh } = await setup(t);
	const fetch = mockCatalog(t, {
		namespaceResponse: Response.json({
			data: { currentUser: { userPreferences: { duoDefaultNamespace: null } } },
		}),
	});
	await assert.rejects(refresh(context), /No default GitLab Duo group/);
	assert.equal(
		fetch.mock.calls.filter(({ arguments: [url] }) => url === "https://gitlab.com/api/graphql").length,
		1,
	);
	assert.deepEqual(await refresh({ ...context, allowNetwork: false }), fallback);
});

test("joins new GitLab refs to wire IDs and keeps only supported proxy models", async (t) => {
	const { context, refresh } = await setup(t);
	mockCatalog(t);
	const models = await refresh(context);
	assert.deepEqual(
		models.map((m) => m.id),
		["gpt-next-2029-02-15", "claude-next-12", "gpt-next-mini", "claude-basic"],
	);
	const [gpt, claude, mini, basic] = models;
	assert.deepEqual(
		[gpt.baseUrl, gpt.name, gpt.contextWindow, gpt.maxTokens, gpt.input],
		[OPENAI_PROXY_URL, "GPT Next", 1_000_000, 128_000, ["text", "image"]],
	);
	assert.deepEqual(
		[claude.baseUrl, claude.name, claude.contextWindow, claude.maxTokens, claude.input],
		[ANTHROPIC_PROXY_URL, "Claude Next", 32_768, 4_096, ["text"]],
	);
	assert.equal(gpt.thinkingLevelMap?.xhigh, "xhigh");
	assert.equal(gpt.thinkingLevelMap?.medium, null);
	assert.equal(claude.thinkingLevelMap?.max, "max");
	assert.equal(mini.maxTokens, mini.contextWindow);
	assert.equal(mini.name, mini.id);
	assert.equal(mini.thinkingLevelMap?.high, "high");
	assert.equal(basic.reasoning, false);
});

test("uses the pinned model rather than registering other GraphQL candidates", async (t) => {
	const { context, refresh } = await setup(t);
	mockCatalog(t, { pinned: { ref: "claude_next" } });
	assert.deepEqual(
		(await refresh(context)).map((m) => m.id),
		["claude-next-12"],
	);
});

test("does not turn a successful empty list into the legacy fallback", async (t) => {
	const { context, refresh } = await setup(t);
	mockCatalog(t, { models: [] });
	assert.deepEqual(await refresh(context), []);
	assert.deepEqual(await refresh({ ...context, allowNetwork: false }), []);
});

test("restores the same login's latest snapshot offline, including after token rotation", async (t) => {
	const { context, path, refresh } = await setup(t);
	const fetch = mockCatalog(t);
	assert.deepEqual(await refresh({ ...context, allowNetwork: false }), fallback);
	assert.deepEqual(await refresh({ ...context, credential: undefined }), fallback);
	assert.equal(fetch.mock.callCount(), 0);
	const first = await refresh(context);
	assert.equal(fetch.mock.callCount(), 4);
	assert.deepEqual(await refresh(context), first);
	assert.equal(fetch.mock.callCount(), 4);

	const restart = catalogRefresher(path, fallback);
	const rotated = {
		...oauth,
		access: "rotated-access",
		refresh: "rotated-refresh",
		catalogOwner: oauthCatalogOwner(oauth),
	};
	assert.deepEqual(await restart({ ...context, credential: rotated, allowNetwork: false }), first);
	assert.deepEqual(
		await restart({
			...context,
			credential: { ...oauth, refresh: "another-account-refresh" },
			allowNetwork: false,
		}),
		fallback,
	);
	assert.deepEqual(await restart({ ...context, credential: undefined, allowNetwork: false }), fallback);
	assert.equal(fetch.mock.callCount(), 4);
	assert.doesNotMatch(await readFile(path, "utf8"), /gitlab-test-(access|refresh)/);
});

test("refreshes a stale cache without discarding it when GitLab OAuth is rejected", async (t) => {
	const { context, path, refresh } = await setup(t);
	const date = t.mock.method(Date, "now", () => 1_800_000_000_000);
	const initial = mockCatalog(t);
	const first = await refresh(context);
	initial.mock.restore();
	date.mock.mockImplementation(() => 1_800_000_000_000 + 16 * 60_000);

	mockCatalog(t, { namespaceResponse: new Response(null, { status: 401 }) });
	await assert.rejects(refresh(context), /HTTP 401/);
	assert.deepEqual(await catalogRefresher(path, fallback)({ ...context, allowNetwork: false }), first);
});

test("reports GraphQL errors and retains fallback when discovery has never succeeded", async (t) => {
	const { context, refresh } = await setup(t);
	mockCatalog(t, { response: Response.json({ errors: [{ message: "Access denied" }] }) });
	await assert.rejects(refresh(context), /could not resolve aiChatAvailableModels/);
	assert.deepEqual(await refresh({ ...context, allowNetwork: false }), fallback);
});

test("a forced refresh reports a Gateway failure without losing the cached list", async (t) => {
	const { context, refresh } = await setup(t);
	const initial = mockCatalog(t);
	const first = await refresh(context);
	initial.mock.restore();

	mockCatalog(t, { gatewayStatus: 503 });
	await assert.rejects(refresh({ ...context, force: true }), /models.yml failed \(HTTP 503\)/);
	assert.deepEqual(await refresh({ ...context, allowNetwork: false }), first);
});

test("a schema change in the Gateway files does not replace the fallback", async (t) => {
	const { context, refresh } = await setup(t);
	mockCatalog(t, { yaml: "catalog: []" });
	await assert.rejects(refresh(context), /invalid AI Gateway model definitions/);
	assert.deepEqual(await refresh({ ...context, allowNetwork: false }), fallback);
});

test("a schema change inside Gateway definitions does not overwrite a successful cache", async (t) => {
	const { context, path, refresh } = await setup(t);
	const initial = mockCatalog(t);
	const first = await refresh(context);
	initial.mock.restore();

	mockCatalog(t, { yaml: definitions.replaceAll("params:", "parameters:") });
	await assert.rejects(refresh({ ...context, force: true }), /no readable AI Gateway proxy definitions/);
	assert.deepEqual(await catalogRefresher(path, fallback)({ ...context, allowNetwork: false }), first);
});

test("Pi's real provider registry publishes discoveries and retains the same environment token's list on failure", async (t) => {
	const { path } = await setup(t);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousToken = process.env.GITLAB_TOKEN;
	process.env.PI_CODING_AGENT_DIR = join(path, "..");
	process.env.GITLAB_TOKEN = oauth.access;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
		else process.env.GITLAB_TOKEN = previousToken;
	});

	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	registerGitLabDuo({ registerProvider: runtime.registerProvider.bind(runtime) } as ExtensionAPI);

	const id = "gitlab-duo";
	const discovery = mockCatalog(t);
	const options = { providers: [id], force: true };
	assert.equal((await runtime.refresh(options)).errors.size, 0);
	const models = await runtime.getAvailable(id);
	assert.equal(models.find((m) => m.id === "gpt-next-2029-02-15")?.baseUrl, OPENAI_PROXY_URL);
	assert.equal(models.find((m) => m.id === "claude-next-12")?.baseUrl, ANTHROPIC_PROXY_URL);
	discovery.mock.restore();

	t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
	assert.match((await runtime.refresh(options)).errors.get(id)?.message ?? "", /HTTP 503/);
	assert.deepEqual(
		(await runtime.getAvailable(id)).map((m) => m.id),
		models.map((m) => m.id),
	);

	process.env.GITLAB_TOKEN = "different-token";
	await runtime.refresh({ providers: [id], allowNetwork: false });
	assert.equal(
		(await runtime.getAvailable(id)).some((m) => m.id === "gpt-next-2029-02-15"),
		false,
	);
});
