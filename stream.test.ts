import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import {
	type Api,
	type Model,
	normalizeContext,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { ANTHROPIC_PROXY_URL, OPENAI_PROXY_URL } from "./catalog.ts";
import { streamGitLabDuo } from "./index.ts";

const directAccessUrl = "https://gitlab.com/api/v4/ai/third_party_agents/direct_access";
const anthropicMessagesUrl = "https://cloud.gitlab.com/ai/v1/proxy/anthropic/v1/messages";
const openAIResponsesUrl = "https://cloud.gitlab.com/ai/v1/proxy/openai/v1/responses";
const gatewayToken = "fixture-direct-access";
const gatewayHeaders = { "X-Gitlab-Instance-Id": "fixture-instance" };
const prompt = "Look up the weather in Tokyo.";
const tool = {
	name: "lookup_weather",
	description: "Look up the weather for a city.",
	parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};
const textChunks = ["I'll look up ", "Tokyo's weather."] as const;
const argumentChunks = ['{"city":', '"Tokyo"}'] as const;

const modelDefaults = {
	provider: "gitlab-duo",
	api: "gitlab-duo-api",
	input: ["text"],
	reasoning: true,
	contextWindow: 128_000,
	maxTokens: 16_384,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies Omit<Model<Api>, "id" | "name" | "baseUrl">;

test("streams a newly discovered Claude model through Anthropic Messages with adaptive thinking", async (t) => {
	const model: Model<Api> = {
		...modelDefaults,
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		baseUrl: ANTHROPIC_PROXY_URL,
		thinkingLevelMap: {
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: "max",
		},
	};
	const body = await streamWithMock(t, model, {
		url: anthropicMessagesUrl,
		events: anthropicEvents(model.id),
		toolCallId: "toolu_weather",
		reasoning: "max",
	});

	assert.partialDeepStrictEqual(body, {
		messages: [{ role: "user", content: prompt }],
		tools: [{ name: tool.name, description: tool.description, input_schema: tool.parameters }],
		thinking: { type: "adaptive" },
		output_config: { effort: "max" },
	});
});

test("streams a newly discovered GPT model through OpenAI Responses with its advertised reasoning effort", async (t) => {
	const model: Model<Api> = {
		...modelDefaults,
		id: "gpt-5.2-2025-12-11",
		name: "GPT-5.2",
		baseUrl: OPENAI_PROXY_URL,
		thinkingLevelMap: {
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: null,
		},
	};
	const body = await streamWithMock(t, model, {
		url: openAIResponsesUrl,
		events: openAIEvents(model.id),
		toolCallId: "call_weather|fc_weather",
		reasoning: "xhigh",
	});

	assert.partialDeepStrictEqual(body, {
		input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
		tools: [
			{
				type: "function",
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			},
		],
		reasoning: { effort: "xhigh" },
	});
});

test("keeps budget-based thinking for legacy Claude models without an effort map", async (t) => {
	const model: Model<Api> = {
		...modelDefaults,
		id: "claude-sonnet-4-5-20250929",
		name: "Claude Sonnet 4.5",
		baseUrl: ANTHROPIC_PROXY_URL,
	};
	const body = await streamWithMock(t, model, {
		url: anthropicMessagesUrl,
		events: anthropicEvents(model.id),
		toolCallId: "toolu_weather",
		reasoning: "low",
	});

	assert.partialDeepStrictEqual(body, { thinking: { type: "enabled" } });
	assert.ok(body.thinking.budget_tokens > 0, "legacy thinking sends a positive token budget");
	assert.equal(body.output_config, undefined);
});

type WireEvent = { type: string } & Record<string, unknown>;

async function streamWithMock(
	t: TestContext,
	model: Model<Api>,
	fixture: {
		url: string;
		events: WireEvent[];
		toolCallId: string;
		reasoning: SimpleStreamOptions["reasoning"];
	},
) {
	const gitlabToken = `fixture-gitlab-access-${model.id}`;
	const requests: Request[] = [];
	t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		requests.push(request);
		const url = new URL(request.url);
		const endpoint = url.origin + url.pathname;
		if (endpoint === directAccessUrl) {
			return Response.json({ token: gatewayToken, headers: gatewayHeaders });
		}
		if (endpoint === fixture.url) return sseResponse(fixture.events);
		return new Response(`Unexpected fetch: ${request.method} ${request.url}`, { status: 400 });
	});

	const context = normalizeContext({
		messages: [{ role: "user", content: prompt, timestamp: 0 }],
		tools: [tool],
	});
	const stream = streamGitLabDuo(model, context, {
		apiKey: gitlabToken,
		reasoning: fixture.reasoning,
		cacheRetention: "none",
	});
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	const message = await stream.result();

	const endpoints = requests.map((request) => {
		const url = new URL(request.url);
		return [request.method, url.origin + url.pathname];
	});
	assert.deepEqual(
		endpoints,
		[
			["POST", directAccessUrl],
			["POST", fixture.url],
		],
		message.errorMessage ?? "request endpoints",
	);
	const [directAccess, inference] = requests;
	assert.equal(directAccess.headers.get("authorization"), `Bearer ${gitlabToken}`);
	assert.deepEqual(await directAccess.json(), { feature_flags: { DuoAgentPlatformNext: true } });
	assert.equal(inference.headers.get("authorization"), `Bearer ${gatewayToken}`);
	assert.equal(inference.headers.get("x-gitlab-instance-id"), gatewayHeaders["X-Gitlab-Instance-Id"]);
	const body = await inference.json();
	assert.partialDeepStrictEqual(body, { model: model.id, stream: true });

	assert.equal(events.at(-1)?.type, "done", message.errorMessage ?? "stream completion");
	assert.equal(message.model, model.id);
	assert.equal(message.stopReason, "toolUse");
	assert.deepEqual(
		events.filter((event) => event.type === "text_delta").map((event) => event.delta),
		textChunks,
	);
	assert.deepEqual(
		events.filter((event) => event.type === "toolcall_delta").map((event) => event.delta),
		argumentChunks,
	);
	assert.deepEqual(
		message.content.map((block) => block.type),
		["text", "toolCall"],
	);
	assert.partialDeepStrictEqual(message.content[0], { type: "text", text: textChunks.join("") });
	assert.deepEqual(events.find((event) => event.type === "toolcall_end")?.toolCall, {
		type: "toolCall",
		id: fixture.toolCallId,
		name: tool.name,
		arguments: { city: "Tokyo" },
	});
	return body;
}

function sseResponse(events: WireEvent[]): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) {
				controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
			}
			controller.close();
		},
	});
	return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

function anthropicEvents(model: string): WireEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_weather",
				type: "message",
				role: "assistant",
				model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 24, output_tokens: 1 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		...textChunks.map((text) => ({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text },
		})),
		{ type: "content_block_stop", index: 0 },
		{
			type: "content_block_start",
			index: 1,
			content_block: { type: "tool_use", id: "toolu_weather", name: tool.name, input: {} },
		},
		...argumentChunks.map((partial_json) => ({
			type: "content_block_delta",
			index: 1,
			delta: { type: "input_json_delta", partial_json },
		})),
		{ type: "content_block_stop", index: 1 },
		{
			type: "message_delta",
			delta: { stop_reason: "tool_use", stop_sequence: null },
			usage: { output_tokens: 18 },
		},
		{ type: "message_stop" },
	];
}

function openAIEvents(model: string): WireEvent[] {
	const response = {
		id: "resp_weather",
		object: "response",
		created_at: 1,
		model,
		status: "in_progress",
		output: [],
	};
	const message = {
		id: "msg_weather",
		type: "message",
		role: "assistant",
		status: "in_progress",
		content: [],
	};
	const outputText = {
		type: "output_text",
		text: textChunks.join(""),
		annotations: [],
		logprobs: [],
	};
	const completedMessage = { ...message, status: "completed", content: [outputText] };
	const call = {
		id: "fc_weather",
		call_id: "call_weather",
		type: "function_call",
		name: tool.name,
		arguments: "",
		status: "in_progress",
	};
	const completedCall = { ...call, status: "completed", arguments: argumentChunks.join("") };
	const textPosition = { item_id: message.id, output_index: 0, content_index: 0 };
	const callPosition = { item_id: call.id, output_index: 1 };

	const events = [
		{ type: "response.created", response },
		{ type: "response.output_item.added", output_index: 0, item: message },
		{ type: "response.content_part.added", ...textPosition, part: { ...outputText, text: "" } },
		...textChunks.map((delta) => ({
			type: "response.output_text.delta",
			...textPosition,
			delta,
			logprobs: [],
		})),
		{ type: "response.output_text.done", ...textPosition, text: outputText.text, logprobs: [] },
		{ type: "response.content_part.done", ...textPosition, part: outputText },
		{ type: "response.output_item.done", output_index: 0, item: completedMessage },
		{ type: "response.output_item.added", output_index: 1, item: call },
		...argumentChunks.map((delta) => ({
			type: "response.function_call_arguments.delta",
			...callPosition,
			delta,
		})),
		{
			type: "response.function_call_arguments.done",
			...callPosition,
			name: call.name,
			arguments: completedCall.arguments,
		},
		{ type: "response.output_item.done", output_index: 1, item: completedCall },
		{
			type: "response.completed",
			response: {
				...response,
				status: "completed",
				output: [completedMessage, completedCall],
				usage: {
					input_tokens: 24,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens: 18,
					output_tokens_details: { reasoning_tokens: 0 },
					total_tokens: 42,
				},
			},
		},
	];
	return events.map((event, sequence_number) => ({ ...event, sequence_number }));
}
