import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import type {
	Credential,
	OAuthCredentials,
	RefreshModelsContext,
	ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { parse as parseYaml } from "yaml";

export const GITLAB_URL = "https://gitlab.com";
export const GATEWAY_URL = "https://cloud.gitlab.com";
export const ANTHROPIC_PROXY_URL = `${GATEWAY_URL}/ai/v1/proxy/anthropic/`;
export const OPENAI_PROXY_URL = `${GATEWAY_URL}/ai/v1/proxy/openai/v1`;

const GATEWAY_CATALOG_URL = `${GITLAB_URL}/gitlab-org/modelops/applied-ml/code-suggestions/ai-assist/-/raw/main/ai_gateway/model_selection`;
const CACHE_TTL_MS = 15 * 60_000;
const DISCOVERY_TIMEOUT_MS = 10_000;
const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_MAX_TOKENS = 4_096;
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const NO_PRICE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const DEFAULT_NAMESPACE_QUERY = `query PiGitLabDuoNamespace {
	currentUser { userPreferences { duoDefaultNamespace { id } } }
}`;

const AVAILABLE_MODELS_QUERY = `query PiGitLabDuoModels($rootNamespaceId: GroupID!) {
	aiChatAvailableModels(rootNamespaceId: $rootNamespaceId) {
		defaultModel { ref name }
		selectableModels { ref name }
		pinnedModel { ref name }
	}
}`;

type ChatModelConfig = Extract<ProviderModelConfig, { type?: "chat" }>;

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function modelId(value: unknown): string | undefined {
	return typeof value === "string" && /^[\w.-]+$/.test(value) ? value : undefined;
}

function name(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function thinkingMap(effortLevels: unknown): ThinkingLevelMap | undefined {
	if (!Array.isArray(effortLevels) || !THINKING_LEVELS.some((level) => effortLevels.includes(level))) return;
	return Object.fromEntries(
		THINKING_LEVELS.map((level) => [level, effortLevels.includes(level) ? level : null]),
	);
}

function offeredModels(data: Record<string, unknown> | undefined): unknown[] {
	const list = object(data?.aiChatAvailableModels);
	if (!list || !Array.isArray(list.selectableModels)) {
		throw new Error("GitLab did not return an aiChatAvailableModels list.");
	}
	return list.pinnedModel ? [list.pinnedModel] : [...list.selectableModels, list.defaultModel];
}

function convertCatalog(
	offered: unknown[],
	modelDefinitions: unknown,
	modelRestrictions: unknown,
	fallback: ChatModelConfig[],
): ChatModelConfig[] {
	const definitions = object(modelDefinitions)?.models;
	const restrictions = object(modelRestrictions)?.restricted_models;
	if (!Array.isArray(definitions) || definitions.length === 0 || !Array.isArray(restrictions)) {
		throw new Error("GitLab returned invalid AI Gateway model definitions.");
	}

	const rows = definitions.map(object);
	const restrictedRefs = new Set(restrictions.map((row) => modelId(object(row)?.identifier)));
	restrictedRefs.delete(undefined);
	const restrictedIds = new Set(
		rows
			.filter((row) => restrictedRefs.has(modelId(row?.gitlab_identifier)))
			.map((row) => modelId(object(row?.params)?.model)),
	);
	const byRef = new Map(
		rows.flatMap((row) => {
			const ref = modelId(row?.gitlab_identifier);
			const proxy = row?.proxy_provider;
			return ref && modelId(object(row?.params)?.model) && (proxy === "anthropic" || proxy === "openai")
				? [[ref, row] as const]
				: [];
		}),
	);
	if (byRef.size === 0) throw new Error("GitLab returned no readable AI Gateway proxy definitions.");
	const previous = new Map(fallback.map((row) => [row.id, row]));
	const result = new Map<string, ChatModelConfig>();

	for (const entry of offered) {
		const candidate = object(entry);
		const ref = modelId(candidate?.ref);
		if (!ref) continue;
		const definition = byRef.get(ref);
		const params = object(definition?.params);
		const id = modelId(params?.model);
		const proxy = definition?.proxy_provider;
		if (!id || restrictedIds.has(id) || result.has(id) || (proxy !== "anthropic" && proxy !== "openai"))
			continue;

		const known = previous.get(id);
		const contextWindow =
			positiveInteger(definition?.max_context_tokens) ?? known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
		const maxTokens = Math.min(
			positiveInteger(params?.max_tokens) ?? known?.maxTokens ?? DEFAULT_MAX_TOKENS,
			contextWindow,
		);
		const thinkingLevelMap = thinkingMap(definition?.effort_levels);
		const image =
			definition?.supports_vision === true ||
			(definition?.supports_vision === undefined && known?.input.includes("image"));

		result.set(id, {
			id,
			name: name(candidate?.name) ?? name(definition?.name) ?? known?.name ?? id,
			baseUrl: proxy === "anthropic" ? ANTHROPIC_PROXY_URL : OPENAI_PROXY_URL,
			reasoning:
				Boolean(thinkingLevelMap) || (definition?.effort_levels === undefined && (known?.reasoning ?? false)),
			thinkingLevelMap,
			input: image ? ["text", "image"] : ["text"],
			cost: known?.cost ?? NO_PRICE,
			contextWindow,
			maxTokens,
		});
	}
	return [...result.values()];
}

interface CatalogSources {
	offered: unknown[];
	definitions: unknown;
	restrictions: unknown;
}

async function fetchOfferedModels(token: string, signal: AbortSignal): Promise<unknown[]> {
	async function graphql(field: string, query: string, variables?: Record<string, string>) {
		const response = await fetch(`${GITLAB_URL}/api/graphql`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ query, variables }),
			redirect: "error",
			signal,
		});
		if (!response.ok) throw new Error(`GitLab model discovery failed at ${field} (HTTP ${response.status}).`);

		const result = object(await response.json());
		const errors = result?.errors;
		if (Array.isArray(errors) && errors.length > 0) {
			throw new Error(`GitLab could not resolve ${field}. Check your GitLab Duo group and access.`);
		}
		return object(result?.data);
	}

	const data = await graphql("duoDefaultNamespace", DEFAULT_NAMESPACE_QUERY);
	const preferences = object(object(data?.currentUser)?.userPreferences);
	const groupId = object(preferences?.duoDefaultNamespace)?.id;
	if (typeof groupId !== "string" || !/^gid:\/\/gitlab\/Group\/[1-9]\d*$/.test(groupId)) {
		throw new Error("No default GitLab Duo group. Select one in your GitLab profile preferences.");
	}

	return offeredModels(
		await graphql("aiChatAvailableModels", AVAILABLE_MODELS_QUERY, { rootNamespaceId: groupId }),
	);
}

async function fetchCatalog(token: string, signal: AbortSignal): Promise<CatalogSources> {
	async function fetchDefinition(file: string): Promise<unknown> {
		const response = await fetch(`${GATEWAY_CATALOG_URL}/${file}`, { signal });
		if (!response.ok) throw new Error(`GitLab AI Gateway ${file} failed (HTTP ${response.status}).`);
		// GitLab's files use YAML 1.1-style digit separators (for example 128_000).
		return parseYaml(await response.text(), { version: "1.1" });
	}

	// The Gateway files are public and never receive the GitLab OAuth token.
	const [offered, definitions, restrictions] = await Promise.all([
		fetchOfferedModels(token, signal),
		fetchDefinition("models.yml"),
		fetchDefinition("model_restrictions.yml"),
	]);
	return { offered, definitions, restrictions };
}

function fingerprint(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** Retain the catalog owner across OAuth token rotations, including existing logins. */
export function oauthCatalogOwner(credentials: OAuthCredentials): string {
	return typeof credentials.catalogOwner === "string"
		? credentials.catalogOwner
		: fingerprint(credentials.refresh);
}

function catalogOwner(credential: Credential | undefined): string | undefined {
	if (credential?.type === "oauth") return oauthCatalogOwner(credential);
	// Pi does not resolve environment credentials during the offline phase.
	const key = credential ? credential.key : process.env.GITLAB_TOKEN;
	return key ? fingerprint(key) : undefined;
}

interface CatalogSnapshot extends CatalogSources {
	owner: string;
	checkedAt: number;
}

async function readSnapshot(path: string, owner: string): Promise<CatalogSnapshot | undefined> {
	try {
		const saved = object(JSON.parse(await readFile(path, "utf8")));
		if (saved?.owner !== owner || !Array.isArray(saved.offered)) return;
		const checkedAt = positiveInteger(saved.checkedAt);
		if (!checkedAt || checkedAt > Date.now()) return;
		return {
			owner,
			checkedAt,
			offered: saved.offered,
			definitions: saved.definitions,
			restrictions: saved.restrictions,
		};
	} catch {
		// Missing, corrupt or unreadable cache: use the fallback catalog.
		return undefined;
	}
}

async function saveSnapshot(path: string, snapshot: CatalogSnapshot, signal: AbortSignal): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600, signal });
		signal.throwIfAborted();
		await rename(temporary, path);
	} catch {
		// Cache I/O is best effort. Keep the current catalog usable without disk access.
		await unlink(temporary).catch(() => {});
	}
}

export function catalogRefresher(path: string, fallback: ChatModelConfig[]) {
	let lastSuccess: { owner: string; checkedAt: number; models: ChatModelConfig[] } | undefined;

	return async ({
		credential,
		allowNetwork,
		force,
		signal,
	}: RefreshModelsContext): Promise<ChatModelConfig[]> => {
		const owner = catalogOwner(credential);
		if (!owner) {
			lastSuccess = undefined;
			return fallback;
		}
		let cached = lastSuccess?.owner === owner ? lastSuccess : undefined;
		if (!cached) {
			const snapshot = await readSnapshot(path, owner);
			if (snapshot) {
				try {
					const { offered, definitions, restrictions, checkedAt } = snapshot;
					cached = {
						owner,
						checkedAt,
						models: convertCatalog(offered, definitions, restrictions, fallback),
					};
				} catch {
					// Ignore an invalid cache and refresh it on the next network phase.
				}
			}
		}
		if (!allowNetwork || (!force && cached && Date.now() - cached.checkedAt < CACHE_TTL_MS)) {
			return cached?.models ?? fallback;
		}

		const access = credential?.type === "oauth" ? credential.access : credential?.key;
		if (!access) return cached?.models ?? fallback;

		// Pi installs the cache-only phase before making this call. A thrown fetch error
		// leaves that catalog in place and lets Pi report the refresh failure in the selector.
		const sources = await fetchCatalog(
			access,
			AbortSignal.any([signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]),
		);
		const models = convertCatalog(sources.offered, sources.definitions, sources.restrictions, fallback);
		signal.throwIfAborted();
		const checkedAt = Date.now();
		await saveSnapshot(path, { ...sources, owner, checkedAt }, signal);
		signal.throwIfAborted();
		lastSuccess = { owner, checkedAt, models };
		return models;
	};
}
