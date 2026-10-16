/**
 * DSH 原生 Gemini 适配器插件（路由：opencode-argon）。
 *
 * 直接说 Google `generateContent` 协议打 OpenCode Go 网关，替掉此前的「回环桥接 + OpenAI 翻译」。
 * 插件只依赖 Node 内建与本目录模块 —— 用户插件 import 不到 `@deepseek-ai/*`（实测 ERR_MODULE_NOT_FOUND），
 * 所以 DSH 的 chunk 词汇表在这里按源码硬编码；形状依据 dsh-llm 0.2.0-rc.2：
 *   - chunk 字面量联合 dsh-llm/lib/typert.host.js:504-505
 *   - 适配器契约 dsh-llm/lib/index.js:1664-1740
 *   - 错误旁路 dsh-llm/lib/types/adapter-failure.js:13-91（自带 failure 快照 + 同名 code 才保得住 code）
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEFAULT_BASE, callGemini, thinkingConfigFor } from '../gemini-client.mjs'

const ROUTE = 'opencode-argon'
const MODEL = 'gemini-4-argon-contributor'

/* ---------- Gemini 只认这些 JSON Schema 关键字，多一个（additionalProperties/$schema…）就 400 ---------- */
const SCHEMA_KEYS = new Set([
	'type', 'format', 'description', 'nullable', 'enum', 'items', 'properties',
	'required', 'anyOf', 'minItems', 'maxItems', 'minimum', 'maximum', 'pattern',
	'default', 'title', 'example', 'propertyOrdering'
])

function sanitizeSchema(schema) {
	if (Array.isArray(schema)) return schema.map(sanitizeSchema)
	if (schema === null || typeof schema !== 'object') return schema
	const out = {}
	for (const [key, value] of Object.entries(schema)) {
		if (!SCHEMA_KEYS.has(key)) continue
		if (key === 'properties') out.properties = Object.fromEntries(Object.entries(value ?? {}).map(([name, sub]) => [name, sanitizeSchema(sub)]))
		else if (key === 'items' || key === 'anyOf') out[key] = sanitizeSchema(value)
		else out[key] = value
	}
	return out
}

/* ---------- 错误：不 import LlmError 也能保住 code ---------- */
class GeminiError extends Error {
	constructor(message, code, facts = {}) {
		super(message)
		this.name = 'GeminiError'
		this.code = code // 必须是自有数据属性，getter 不算
		this.failure = { message, code, ...facts }
	}
}

/* ---------- chunk 工厂（DSH 无 chunk 构造器，只有字面量联合） ---------- */
const blockStart = (index, blockType) => ({ type: 'block-start', index, blockType })
const blockEnd = (index, block) => ({ type: 'block-end', index, block })
const textDelta = (index, text) => ({ type: 'text-delta', index, text })
const reasoningDelta = (index, text) => ({ type: 'reasoning-delta', index, text })
const toolCallDelta = (index, id, argumentsDelta, name) => ({
	type: 'tool-call-delta',
	index,
	id,
	...(name === undefined ? {} : { name }),
	argumentsDelta
})

/* ---------- 上游失败 → DSH code（对齐 deepseek:1743-1765 / pi-ai:1380-1390 的映射） ---------- */
function classify(error, signal) {
	if (signal?.aborted) return new GeminiError('gemini request aborted by caller', 'ABORTED', { cause: error })
	if (error instanceof GeminiError) return error
	const status = typeof error?.status === 'number' ? error.status : undefined
	const detail = `${error?.message ?? ''} ${error?.upstream ?? ''}`
	const facts = status === undefined ? {} : { status }
	if (status === 401 || status === 403) return new GeminiError(error.message, 'AUTH', facts)
	if (status === 429) return new GeminiError(error.message, 'RATE_LIMIT', facts) // ponytail: 未转 Retry-After，默认重试策略够用
	if (status === 402 || /quota|billing|credit|exceeded your current quota/i.test(detail)) return new GeminiError(error.message, 'QUOTA', facts)
	if (status === 400 || status === 413) {
		return /(?:input|prompt|request|context)[^.]{0,60}(?:too long|exceed|larger than|maximum)/i.test(detail)
			? new GeminiError(error.message, 'CONTEXT_WINDOW_EXCEEDED', facts)
			: new GeminiError(error.message, 'INVALID_REQUEST', facts)
	}
	if (status !== undefined && status >= 500) return new GeminiError(error.message, 'SERVER', facts)
	return new GeminiError(error.message || 'gemini transport failure', status === undefined ? 'TRANSPORT' : `HTTP_${status}`, facts)
}

/* ---------- 目录：能力都在这里声明，GUI 靠 listModels 才能选中 ---------- */
const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
/** 模型元数据。contextWindow/maxTokens 取 Gemini 3 量级；maxOutputTokens 超上限会被上游 400，实测通过即算数。 */
const MODEL_META = {
	name: 'Gemini 4 Argon',
	contextWindow: 1_048_576,
	maxTokens: 65_536,
	efforts: EFFORTS,
	defaultEffort: 'medium'
}

/* 第三方插件 import 不到 attributionHeaders()（dsh-llm/lib/types/attribution.js:43-45），照抄其默认值。 */
const ATTRIBUTION = { 'user-agent': 'deepseek-harness/0.2.0-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)' }

/* ---------- thoughtSignature 回放：Gemini 3 多轮工具调用要求把签名带回去 ---------- */
const signatures = new Map() // toolCallId → thoughtSignature

const textOf = (content) => (content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('')
const parseArgs = (raw) => {
	try {
		const value = JSON.parse(raw)
		return typeof value === 'object' && value !== null ? value : {}
	} catch {
		return {}
	}
}

export class GeminiAdapter {
	#config

	constructor(config) {
		this.#config = config
	}

	providerInfo(provider) {
		return { id: provider, name: 'Gemini 4 Argon (OpenCode Go)' }
	}

	// 下面三个是 LlmAdapter 基类给的默认实现；第三方插件拿不到基类，必须自己补齐——
	// registerAdapter 会逐个检查方法存在（缺一个就 INVALID_ADAPTER 风格的 TypeError）。
	providerRetryPolicy(_provider) {
		return undefined // 用 DSH 默认重试策略（EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT）
	}

	imageRequestPricing(_provider, _model) {
		return undefined
	}

	async prepareCall(provider, model, signal) {
		// 必须 await：DSH 的 normalizeModelInfo 直接读 provider/id/name，拿到 Promise 会判 INVALID_MODEL_INFO。
		return {
			model: await this.resolveModel(provider, model, signal),
			stream: (options) => this.stream(options)
		}
	}

	listModels(provider) {
		return Promise.resolve([{ provider, id: MODEL, name: MODEL_META.name, inputModalities: ['text'] }])
	}

	resolveModel(provider, model) {
		return Promise.resolve({
			provider,
			id: model,
			name: MODEL_META.name,
			inputModalities: ['text'], // 纯文本：图片不投影成文本句柄，但也不支持（translate.mjs 已能转 inlineData，等确认视觉能力再开）
			context: { contextWindow: MODEL_META.contextWindow },
			defaultMaxTokens: MODEL_META.maxTokens,
			reasoning: {
				efforts: MODEL_META.efforts.map((id) => ({ id, name: id.toUpperCase() })),
				defaultEffort: MODEL_META.defaultEffort
			},
			systemPromptUpdate: 'in-history'
		})
	}

	stream(options) {
		return this.#generate(options)
	}

	/* ---------- DSH 词汇 → Gemini generateContent ---------- */
	#buildBody(options) {
		const systemTexts = []
		if (typeof options.system === 'string' && options.system.length > 0) systemTexts.push(options.system)
		const contents = []
		const toolNames = new Map()
		const push = (role, parts) => {
			if (parts.length === 0) return
			const last = contents[contents.length - 1]
			const isResponse = (list) => list.some((part) => part.functionResponse !== undefined)
			// 相邻 user turn 只在「同为工具结果」或「同为普通输入」时合并，别把函数响应和文本混进一个 turn。
			if (last !== undefined && last.role === role && role === 'user' && isResponse(last.parts) === isResponse(parts)) last.parts.push(...parts)
			else contents.push({ role, parts })
		}

		for (const message of options.messages ?? []) {
			if (message.role === 'system' || message.role === 'developer') {
				const text = textOf(message.content)
				if (text) systemTexts.push(text)
				continue
			}
			if (message.role === 'assistant') {
				const parts = []
				const text = textOf(message.content)
				if (text) parts.push({ text })
				for (const block of message.content ?? []) {
					if (block.type !== 'tool-call') continue
					const name = block.name || 'unknown_tool'
					if (block.id) toolNames.set(block.id, name)
					const part = { functionCall: { name, args: parseArgs(block.arguments) } }
					const signature = block.id === undefined ? undefined : signatures.get(block.id)
					if (signature !== undefined) part.thoughtSignature = signature
					parts.push(part)
				}
				push('model', parts)
				continue
			}
			if (message.role === 'tool') {
				push('user', [{
					functionResponse: {
						name: toolNames.get(message.toolCallId) ?? 'unknown_tool',
						response: { result: textOf(message.content) }
					}
				}])
				continue
			}
			const parts = []
			const text = textOf(message.content)
			if (text) parts.push({ text })
			push('user', parts)
		}

		const body = { contents }
		const system = systemTexts.join('\n\n')
		if (system) body.systemInstruction = { parts: [{ text: system }] }

		const declarations = (options.tools ?? [])
			.filter((tool) => typeof tool?.name === 'string' && tool.name.length > 0)
			.map((tool) => {
				const declaration = { name: tool.name }
				if (typeof tool.description === 'string' && tool.description.length > 0) declaration.description = tool.description
				declaration.parameters = sanitizeSchema(tool.parameters ?? { type: 'object', properties: {} })
				return declaration
			})
		if (declarations.length > 0) {
			body.tools = [{ functionDeclarations: declarations }]
			body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } } // GenerateOptions 没有 toolChoice
		}

		const generationConfig = {}
		if (typeof options.temperature === 'number') generationConfig.temperature = options.temperature
		if (typeof options.maxTokens === 'number' && options.maxTokens > 0) generationConfig.maxOutputTokens = options.maxTokens
		const thinking = thinkingConfigFor(options.reasoningEffort ?? MODEL_META.defaultEffort)
		if (thinking !== undefined) generationConfig.thinkingConfig = thinking
		if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig
		return body
	}

	/* ---------- 主流程：上游事件 → DSH chunk ---------- */
	async *#generate(options) {
		if (options.stop !== undefined) throw new GeminiError('gemini adapter does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
		const body = this.#buildBody(options)

		let events
		try {
			events = await this.#config.transport({
				baseURL: this.#config.baseURL,
				model: options.model,
				body,
				stream: true,
				signal: options.signal,
				sessionId: this.#config.sessionId,
				extraHeaders: ATTRIBUTION
			})
		} catch (error) {
			throw classify(error, options.signal)
		}

		let nextIndex = 0
		let open = null
		let sawToolCall = false
		let usage
		let upstreamReason
		const close = function* () {
			if (open === null) return
			if (open.type === 'tool-call') yield blockEnd(open.index, { type: 'tool-call', id: open.id, name: open.name, arguments: open.args })
			else yield blockEnd(open.index, { type: open.type, text: open.text })
			open = null
		}

		try {
			for await (const event of events) {
				if (options.signal?.aborted) throw new GeminiError('gemini request aborted by caller', 'ABORTED')
				const candidate = event?.candidates?.[0]
				for (const part of candidate?.content?.parts ?? []) {
					if (typeof part.text === 'string' && part.text.length > 0) {
						const type = part.thought === true ? 'reasoning' : 'text'
						if (open === null || open.type !== type) {
							yield* close()
							open = { index: nextIndex++, type, text: '' }
							yield blockStart(open.index, type)
						}
						open.text += part.text
						yield type === 'reasoning' ? reasoningDelta(open.index, part.text) : textDelta(open.index, part.text)
						continue
					}
					if (part.functionCall !== undefined) {
						yield* close()
						const index = nextIndex++
						const id = `gemini-${randomUUID()}` // 上游不给 id，自己合成
						const name = part.functionCall.name ?? 'unknown_tool'
						if (typeof part.thoughtSignature === 'string' && part.thoughtSignature.length > 0) signatures.set(id, part.thoughtSignature)
						const json = JSON.stringify(part.functionCall.args ?? {})
						open = { index, type: 'tool-call', id, name, args: json }
						sawToolCall = true
						yield blockStart(index, 'tool-call')
						yield toolCallDelta(index, id, '', name) // 首个 delta 带 name，arguments 为空串
						yield toolCallDelta(index, id, json)
					}
				}
				if (event?.usageMetadata !== undefined) {
					const meta = event.usageMetadata
					const inputTokens = meta.promptTokenCount ?? 0
					const outputTokens = (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0)
					usage = { inputTokens, outputTokens, totalTokens: meta.totalTokenCount ?? inputTokens + outputTokens }
				}
				if (candidate?.finishReason !== undefined) upstreamReason = candidate.finishReason
			}
		} catch (error) {
			yield* close()
			throw classify(error, options.signal)
		}
		yield* close()

		const reason = sawToolCall ? { kind: 'tool-calls' }
			: upstreamReason === 'MAX_TOKENS' ? { kind: 'max-tokens' }
				: { kind: 'stop' }
		if (nextIndex === 0 && reason.kind === 'stop') {
			throw new GeminiError(`gemini model "${options.model}" returned a completed response with no content`, 'EMPTY_RESPONSE')
		}
		yield { type: 'usage', usage: usage ?? { inputTokens: 0, outputTokens: 0 } }
		yield { type: 'finish', reason }
	}
}

/* ---------- 插件入口 ---------- */
export const name = 'llm-opencode-argon'
export const inject = ['llm']

export function apply(ctx, config) {
	const plugin = new GeminiAdapter({
		baseURL: config?.baseURL ?? process.env.OPENCODE_BASE ?? DEFAULT_BASE,
		sessionId: resolveSessionId(),
		transport: callGemini
	})
	// 注意：同名路由若仍写在 llm-pi-ai 的 providers 里会 DUPLICATE_ADAPTER，且同层条目并发挂载、行序不保证。
	try {
		ctx.llm.registerAdapter([ROUTE], plugin)
		console.error(`[opencode-argon] 已注册路由 ${ROUTE} → ${MODEL}`)
	} catch (error) {
		console.error(`[opencode-argon] 路由注册失败: ${error?.code ?? ''} ${error?.message}`)
	}
}

/** x-opencode-session：网关只认固定 UUID，落盘复用（与桥接层同一个文件）。 */
function resolveSessionId() {
	if (process.env.OPENCODE_SESSION) return process.env.OPENCODE_SESSION
	const file = fileURLToPath(new URL('../session-id', import.meta.url))
	try {
		const existing = readFileSync(file, 'utf8').trim()
		if (existing.length > 0) return existing
	} catch {
		// 首次运行：下面生成并落盘
	}
	const fresh = randomUUID()
	try {
		writeFileSync(file, `${fresh}\n`, 'utf8')
	} catch (error) {
		console.error(`[opencode-argon] 无法持久化 session id: ${error.message}`)
	}
	return fresh
}
