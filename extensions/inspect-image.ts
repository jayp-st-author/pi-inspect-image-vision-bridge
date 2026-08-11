import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve as resolvePath } from "node:path";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Model,
} from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	type ModelRuntime,
	ModelSelectorComponent,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── Types ───────────────────────────────────────────────────────────

interface VisionConfig {
	provider: string;
	model: string;
	baseUrl?: string;
	maxTokens?: number;
}

interface InspectImageDetails {
	path: string;
	prompt?: string;
	provider: string;
	model: string;
}

type VisionModel = Model<Api>;

const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

// ── Settings I/O ────────────────────────────────────────────────────

function projectSettingsPath(cwd: string): string {
	return join(cwd, ".pi", "settings.json");
}

async function readProjectSettingsRaw(
	cwd: string,
): Promise<Record<string, unknown>> {
	const path = projectSettingsPath(cwd);
	if (!existsSync(path)) return {};
	try {
		const raw = await readFile(path, "utf-8");
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

async function writeProjectSettings(
	cwd: string,
	settings: Record<string, unknown>,
): Promise<void> {
	const path = projectSettingsPath(cwd);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

async function saveVisionConfig(
	cwd: string,
	config: VisionConfig,
): Promise<void> {
	const settings = await readProjectSettingsRaw(cwd);
	settings.visionConfig = config;
	await writeProjectSettings(cwd, settings);
}

function getVisionConfig(cwd: string): VisionConfig | undefined {
	const path = projectSettingsPath(cwd);
	if (!existsSync(path)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<
			string,
			unknown
		>;
		const config = raw.visionConfig;
		if (!config || typeof config !== "object") return undefined;
		const { provider, model } = config as Partial<VisionConfig>;
		if (typeof provider !== "string" || typeof model !== "string")
			return undefined;
		return config as VisionConfig;
	} catch {
		return undefined;
	}
}

// ── API URL Resolution ──────────────────────────────────────────────

function resolveApiUrl(provider: string, baseUrl?: string): string {
	if (baseUrl) {
		const normalized = baseUrl.replace(/\/$/, "");
		return normalized.endsWith("/chat/completions")
			? normalized
			: `${normalized}/v1/chat/completions`;
	}
	const known: Record<string, string> = {
		openrouter: "https://openrouter.ai/api/v1/chat/completions",
		openai: "https://api.openai.com/v1/chat/completions",
	};
	const url = known[provider.toLowerCase()];
	if (!url) {
		throw new Error(
			`Unknown vision provider "${provider}". Set "baseUrl" in visionConfig, or use one of: ${Object.keys(known).join(", ")}.`,
		);
	}
	return url;
}

// ── Vision model selection ──────────────────────────────────────────

function getAvailableVisionModels(ctx: ExtensionContext): VisionModel[] {
	return ctx.modelRegistry
		.getAvailable()
		.filter((model) => model.input.includes("image"));
}

function getVisionModel(
	ctx: ExtensionContext,
	config: VisionConfig,
): VisionModel | undefined {
	const model = ctx.modelRegistry.find(config.provider, config.model);
	return model?.input.includes("image") ? model : undefined;
}

/**
 * Adapt Pi's public ModelRegistry facade to the exact runtime surface used by
 * Pi's built-in ModelSelectorComponent. The selector is therefore identical
 * to /model (fuzzy search, refresh, current-model highlighting, and keyboard
 * behavior), but its snapshot is limited to vision-capable models.
 */
function createVisionModelRuntime(ctx: ExtensionContext): ModelRuntime {
	return {
		getAvailableSnapshot: () => getAvailableVisionModels(ctx),
		getModel: (provider: string, modelId: string) => {
			const model = ctx.modelRegistry.find(provider, modelId);
			return model?.input.includes("image") ? model : undefined;
		},
		refresh: (options?: Parameters<ModelRuntime["refresh"]>[0]) =>
			ctx.modelRegistry.refresh(options),
		getError: () => ctx.modelRegistry.getError(),
	} as unknown as ModelRuntime;
}

async function selectVisionModel(
	ctx: ExtensionContext,
): Promise<VisionModel | undefined> {
	const available = getAvailableVisionModels(ctx);
	if (available.length === 0) {
		ctx.ui.notify(
			"No authenticated vision-capable models are available. Use /login first, then run /setup-vision again.",
			"warning",
		);
		return undefined;
	}

	const configured = getVisionConfig(ctx.cwd);
	const currentModel = configured ? getVisionModel(ctx, configured) : undefined;

	// The TUI path uses Pi's actual model selector component. RPC and other
	// dialog-capable modes get the same model set through their native selector.
	if (ctx.mode !== "tui") {
		const options = available.map((model) => {
			const providerName = ctx.modelRegistry.getProviderDisplayName(
				model.provider,
			);
			return `${model.provider}/${model.id} — ${providerName}`;
		});
		const choice = await ctx.ui.select("Select vision model", options);
		if (!choice) return undefined;
		const reference = choice.split(" — ", 1)[0];
		const slash = reference.indexOf("/");
		if (slash === -1) return undefined;
		return ctx.modelRegistry.find(
			reference.slice(0, slash),
			reference.slice(slash + 1),
		);
	}

	return ctx.ui.custom<VisionModel | undefined>(
		(tui, _theme, _keybindings, done) => {
			// ModelSelectorComponent saves the selected model as the default model.
			// A no-op adapter keeps that side effect out of the main chat settings;
			// the onSelect callback below saves only visionConfig.
			const settingsAdapter = {
				setDefaultModelAndProvider: () => undefined,
			} as unknown as SettingsManager;

			return new ModelSelectorComponent(
				tui,
				currentModel,
				settingsAdapter,
				createVisionModelRuntime(ctx),
				[],
				(model) => done(model),
				() => done(undefined),
			);
		},
	);
}

async function runVisionSetup(
	ctx: ExtensionContext,
): Promise<VisionConfig | undefined> {
	if (!ctx.hasUI) {
		ctx.ui.notify(
			"Vision setup requires an interactive Pi session.",
			"warning",
		);
		return undefined;
	}

	const model = await selectVisionModel(ctx);
	if (!model) return undefined;

	const previous = getVisionConfig(ctx.cwd);
	const config: VisionConfig = {
		provider: model.provider,
		model: model.id,
		...(previous?.maxTokens === undefined
			? {}
			: { maxTokens: previous.maxTokens }),
	};
	await saveVisionConfig(ctx.cwd, config);
	return config;
}

async function ensureVisionConfig(
	ctx: ExtensionContext,
): Promise<VisionConfig> {
	const existing = getVisionConfig(ctx.cwd);
	if (existing) return existing;

	const configured = await runVisionSetup(ctx);
	if (!configured) {
		throw new Error(
			"No vision model is configured. Run /setup-vision, or add a visionConfig block to .pi/settings.json.",
		);
	}
	return configured;
}

async function resolveVisionRequest(
	ctx: ExtensionContext,
	config: VisionConfig,
): Promise<{ config: VisionConfig; model?: VisionModel }> {
	const model = getVisionModel(ctx, config);
	if (
		model ||
		config.baseUrl ||
		["openai", "openrouter"].includes(config.provider.toLowerCase())
	) {
		return { config, model };
	}

	// A configured registry model can disappear after a provider catalog refresh.
	// Give the user the same selector again rather than failing with an opaque
	// provider/model lookup error.
	ctx.ui.notify(
		`Vision model ${config.provider}/${config.model} is no longer available. Select a replacement.`,
		"warning",
	);
	const replacement = await runVisionSetup(ctx);
	if (!replacement) throw new Error("Vision model selection was cancelled.");
	return { config: replacement, model: getVisionModel(ctx, replacement) };
}

// ── Vision request helpers ──────────────────────────────────────────

function buildVisionPrompt(prompt: string | undefined): string {
	const request = prompt?.trim();
	if (!request) {
		return "Describe the attached image or images in detail. Include visible text, layout, objects, and any details that would help another language model answer the user's request.";
	}
	return [
		"Analyze the attached image or images and provide factual visual context for another language model.",
		`User request: ${request}`,
		"Answer the request using only what can be established from the images.",
	].join("\n\n");
}

function imageAsDataUri(image: ImageContent): string {
	return `data:${image.mimeType};base64,${image.data}`;
}

function extractText(message: AssistantMessage): string {
	return message.content
		.filter(
			(part): part is { type: "text"; text: string } => part.type === "text",
		)
		.map((part) => part.text)
		.join("\n")
		.trim();
}

async function callRegistryVisionModel(
	ctx: ExtensionContext,
	model: VisionModel,
	config: VisionConfig,
	images: ImageContent[],
	prompt: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string> {
	const options =
		config.maxTokens === undefined
			? { signal }
			: { signal, maxTokens: config.maxTokens };
	const response = await ctx.modelRegistry.complete(
		model,
		{
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: buildVisionPrompt(prompt) },
						...images,
					],
					timestamp: Date.now(),
				},
			],
		},
		options,
	);

	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(
			response.errorMessage ?? "The vision model failed to analyze the image.",
		);
	}
	const text = extractText(response);
	if (!text) throw new Error("The vision model returned an empty response.");
	return text;
}

async function callCompatibleVisionApi(
	ctx: ExtensionContext,
	config: VisionConfig,
	images: ImageContent[],
	prompt: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string> {
	const apiKey = await ctx.modelRegistry.getApiKeyForProvider(config.provider);
	if (!apiKey) {
		throw new Error(
			`No API key found for provider "${config.provider}". Configure it via /login or auth.json.`,
		);
	}

	const response = await fetch(resolveApiUrl(config.provider, config.baseUrl), {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: config.model,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: buildVisionPrompt(prompt) },
						...images.map((image) => ({
							type: "image_url",
							image_url: { url: imageAsDataUri(image) },
						})),
					],
				},
			],
			...(config.maxTokens === undefined
				? {}
				: { max_tokens: config.maxTokens }),
		}),
		signal,
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Vision API error (${response.status}): ${errorText}`);
	}

	const data = (await response.json()) as {
		choices?: Array<{
			message?: { content?: string | Array<{ type?: string; text?: string }> };
		}>;
		error?: { message?: string };
	};
	if (data.error)
		throw new Error(
			`Vision API error: ${data.error.message ?? JSON.stringify(data.error)}`,
		);

	const content = data.choices?.[0]?.message?.content;
	let text: string | undefined;
	if (typeof content === "string") {
		text = content.trim();
	} else if (Array.isArray(content)) {
		text = content
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("\n")
			.trim();
	}
	if (!text) throw new Error("Vision API returned an empty response.");
	return text;
}

async function analyzeImages(
	ctx: ExtensionContext,
	images: ImageContent[],
	prompt: string | undefined,
	signal: AbortSignal | undefined,
): Promise<{ text: string; config: VisionConfig; model?: VisionModel }> {
	let config = await ensureVisionConfig(ctx);
	const request = await resolveVisionRequest(ctx, config);
	config = request.config;
	if (request.model) {
		return {
			text: await callRegistryVisionModel(
				ctx,
				request.model,
				config,
				images,
				prompt,
				signal,
			),
			config,
			model: request.model,
		};
	}
	return {
		text: await callCompatibleVisionApi(ctx, config, images, prompt, signal),
		config,
	};
}

function appendVisionContext(
	text: string,
	description: string,
	config: VisionConfig,
): string {
	const label = `${config.provider}/${config.model}`;
	return [
		text,
		"",
		`[Vision context from ${label}]`,
		description,
		"[The original image payload was removed because the selected chat model does not accept images.]",
	].join("\n");
}

function isImagePathMentioned(text: string): boolean {
	return /(?:^|[\s"'([<{])[^\s"'()<>]+\.(?:png|jpe?g|gif|webp|bmp)\b/i.test(
		text,
	);
}

function stripImagesFromMessage<T>(message: T): T {
	if (!message || typeof message !== "object") return message;
	const record = message as { content?: unknown };
	if (!Array.isArray(record.content)) return message;
	const content = record.content.filter((part) => {
		return (
			!part ||
			typeof part !== "object" ||
			(part as { type?: string }).type !== "image"
		);
	});
	if (content.length === record.content.length) return message;
	return {
		...message,
		content:
			content.length > 0
				? content
				: [
						{
							type: "text",
							text: "[Image content handled by the vision bridge.]",
						},
					],
	} as T;
}

// ── Tool schema ─────────────────────────────────────────────────────

const InspectImageParams = Type.Object({
	path: Type.String({ description: "Path to the image file to analyze" }),
	prompt: Type.Optional(
		Type.String({
			description:
				"Custom prompt for the vision model (default: 'Describe this image in detail.')",
		}),
	),
});

// ── Extension factory ───────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Route attached images through the selected vision model before Pi creates
	// the user message. The original bytes never reach a non-vision chat model.
	pi.on("input", async (event, ctx) => {
		if (
			!ctx.model ||
			ctx.model.input.includes("image") ||
			!event.images?.length
		) {
			return { action: "continue" };
		}

		try {
			const result = await analyzeImages(
				ctx,
				event.images,
				event.text,
				ctx.signal,
			);
			return {
				action: "transform",
				text: appendVisionContext(event.text, result.text, result.config),
				images: [],
			};
		} catch (error) {
			ctx.ui.notify(
				`Vision handoff failed: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return { action: "handled" };
		}
	});

	// Remove historical/tool-result image blocks that predate this fork or came
	// from another extension. Newly attached images are removed by the input hook.
	pi.on("context", (event, ctx) => {
		if (!ctx.model || ctx.model.input.includes("image")) return;
		const messages = event.messages.map(stripImagesFromMessage);
		return messages.some((message, index) => message !== event.messages[index])
			? { messages }
			: undefined;
	});

	// Paths mentioned in text still need the explicit inspect_image tool call.
	pi.on("before_agent_start", async (event, ctx) => {
		const currentModel = ctx.model;
		if (
			!currentModel ||
			currentModel.input.includes("image") ||
			!isImagePathMentioned(event.prompt)
		)
			return;

		return {
			message: {
				customType: "inspect-image-hint",
				content:
					"⚠️ The current chat model does not support image input. " +
					"Use `inspect_image` for image paths; pasted/attached images are " +
					"automatically routed through the configured vision model.",
				display: true,
			},
		};
	});

	pi.registerCommand("setup-vision", {
		description:
			"Select the vision model used for image handoff and inspect_image",
		handler: async (_args, ctx) => {
			const config = await runVisionSetup(ctx);
			if (config) {
				const name = ctx.modelRegistry.getProviderDisplayName(config.provider);
				ctx.ui.notify(`Vision model: ${name} / ${config.model}`, "info");
			}
		},
	});

	pi.registerTool(
		defineTool({
			name: "inspect_image",
			label: "Inspect Image",
			description:
				"Analyze an image file using the selected vision-capable model. " +
				"Returns a text description of the image contents.",
			promptSnippet:
				"Analyze an image file using the selected vision-capable model",
			promptGuidelines: [
				"Use inspect_image whenever the user asks about an image path.",
				"Use inspect_image to describe, analyze, extract text from, or answer questions about image files.",
				"If no vision model is configured, run /setup-vision or let the tool open the selector.",
			],
			parameters: InspectImageParams,

			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const { path, prompt } = params;
				const imagePath =
					params.path.startsWith("/") ||
					params.path.startsWith("\\") ||
					/^[a-zA-Z]:/.test(params.path)
						? params.path
						: resolvePath(ctx.cwd, params.path);

				let imageBuffer: Buffer;
				try {
					imageBuffer = await readFile(imagePath);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					throw new Error(
						`Failed to read image file "${params.path}": ${message}`,
					);
				}

				if (imageBuffer.length > MAX_IMAGE_SIZE) {
					throw new Error(
						`Image file "${params.path}" is too large (${(imageBuffer.length / 1024 / 1024).toFixed(1)}MB). Maximum size is 20MB.`,
					);
				}

				const mimeType = MIME_TYPES[extname(imagePath).toLowerCase()];
				if (!mimeType) {
					throw new Error(
						`Unsupported image format. Supported formats: ${Object.keys(MIME_TYPES).join(", ")}.`,
					);
				}

				const image: ImageContent = {
					type: "image",
					data: imageBuffer.toString("base64"),
					mimeType,
				};
				const result = await analyzeImages(ctx, [image], prompt, signal);

				return {
					content: [{ type: "text", text: result.text }],
					details: {
						path,
						prompt,
						provider: result.config.provider,
						model: result.config.model,
					} as InspectImageDetails,
				};
			},
		}),
	);
}
