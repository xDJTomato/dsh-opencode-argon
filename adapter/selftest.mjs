/**
 * 适配器自检：不发网络请求，喂假上游，校验
 *   1) 事件 → DSH chunk 序列与组装不变量；
 *   2) 请求体映射（system / tools / 工具结果 / thinking / 签名回放）；
 *   3) 失败分类（EMPTY_RESPONSE / AUTH）。
 * 跑：node ~/.dsh/opencode-argon/adapter/selftest.mjs
 */
import assert from 'node:assert/strict'
import { GeminiAdapter } from './index.mjs'

const makeAdapter = (events, { fail } = {}) => new GeminiAdapter({
	baseURL: 'http://unused',
	sessionId: 'test-session',
	transport: async function* () {
		if (fail) throw fail
		for (const event of events) yield event
	}
})

const collect = async (options, adapter) => {
	const chunks = []
	for await (const chunk of adapter.stream(options)) chunks.push(chunk)
	return chunks
}

const USER = { role: 'user', content: [{ type: 'text', text: '你好' }], id: 'm1', source: { kind: 'user' } }

/* ---------- 1. chunk 序列与不变量 ---------- */
const EVENTS = [
	{ candidates: [{ content: { parts: [{ text: '想一下', thought: true }] } }] },
	{ candidates: [{ content: { parts: [{ text: '再想', thought: true }] } }] },
	{ candidates: [{ content: { parts: [{ text: '你好' }] } }] },
	{ candidates: [{ content: { parts: [{ text: '，世界' }] } }] },
	{ candidates: [{ content: { parts: [{ functionCall: { name: 'get_weather', args: { city: '上海' } }, thoughtSignature: 'sig-1' }] } }] },
	{ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, thoughtsTokenCount: 3, totalTokenCount: 20 } }
]

const chunks = await collect({ provider: 'opencode-argon', model: 'gemini-4-argon-contributor', messages: [USER], reasoningEffort: 'high' }, makeAdapter(EVENTS))
assert.deepEqual(
	chunks.map((chunk) => chunk.type),
	['block-start', 'reasoning-delta', 'reasoning-delta', 'block-end', 'block-start', 'text-delta', 'text-delta', 'block-end', 'block-start', 'tool-call-delta', 'tool-call-delta', 'block-end', 'usage', 'finish']
)

const indexOf = (type) => chunks.filter((chunk) => chunk.type === type).map((chunk) => chunk.index)
assert.deepEqual(indexOf('block-start'), [0, 1, 2], '块序号必须递增且唯一')
const textBlock = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text').block
assert.equal(textBlock.text, '你好，世界', 'block-end 必须携带累积后的完整文本')
const reasoningBlock = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'reasoning').block
assert.equal(reasoningBlock.text, '想一下再想')
const callBlock = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block
assert.equal(callBlock.name, 'get_weather')
assert.deepEqual(JSON.parse(callBlock.arguments), { city: '上海' })
assert.equal(chunks.at(-2).usage.totalTokens, 20)
assert.equal(chunks.at(-1).reason.kind, 'tool-calls', '有工具调用 → finish.kind 必须是 tool-calls')
assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1, '恰好一个终局')

/* ---------- 2. 请求体映射 ---------- */
let seenBody
const capture = new GeminiAdapter({
	baseURL: 'http://unused',
	sessionId: 'test-session',
	transport: async ({ body }) => {
		seenBody = body
		return (async function* () { yield { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] } })()
	}
})

const toolCallId = chunks.find((chunk) => chunk.type === 'tool-call-delta').id
await collect({
	provider: 'opencode-argon',
	model: 'gemini-4-argon-contributor',
	system: '顶层 system',
	reasoningEffort: 'minimal',
	temperature: 0.3,
	maxTokens: 512,
	tools: [{ name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false, $schema: 'http://x' } }],
	messages: [
		{ role: 'system', content: [{ type: 'text', text: '历史 system' }], id: 'm0', source: { kind: 'system-prompt' } },
		USER,
		{ role: 'assistant', content: [{ type: 'tool-call', id: toolCallId, name: 'get_weather', arguments: '{"city":"上海"}' }], id: 'm2', source: { kind: 'model' } },
		{ role: 'tool', toolCallId, content: [{ type: 'text', text: '晴 26℃' }], id: 'm3', source: { kind: 'tool' } }
	]
}, capture)

assert.deepEqual(seenBody.contents.map((entry) => entry.role), ['user', 'model', 'user'], '角色映射 user/model')
assert.deepEqual(seenBody.systemInstruction.parts, [{ text: '顶层 system\n\n历史 system' }], 'options.system 与 system 消息要合并')
assert.deepEqual(seenBody.contents[2].parts, [{ functionResponse: { name: 'get_weather', response: { result: '晴 26℃' } } }], '工具结果要回填函数名')
assert.equal(seenBody.contents[1].parts[0].thoughtSignature, 'sig-1', 'thoughtSignature 必须按 toolCallId 回放')
assert.equal(seenBody.tools[0].functionDeclarations[0].parameters.additionalProperties, undefined, 'additionalProperties 必须被剔除')
assert.equal(seenBody.tools[0].functionDeclarations[0].parameters.$schema, undefined, '$schema 必须被剔除')
assert.deepEqual(seenBody.tools[0].functionDeclarations[0].parameters.required, ['city'])
assert.deepEqual(seenBody.toolConfig, { functionCallingConfig: { mode: 'AUTO' } })
assert.deepEqual(seenBody.generationConfig.thinkingConfig, { thinkingLevel: 'low', includeThoughts: true }, 'minimal → low（argon 拒 minimal）')
assert.equal(seenBody.generationConfig.temperature, 0.3)
assert.equal(seenBody.generationConfig.maxOutputTokens, 512)

let offConfig
const captureOff = new GeminiAdapter({
	baseURL: 'http://unused',
	sessionId: 'test-session',
	transport: async ({ body }) => {
		offConfig = body.generationConfig
		return (async function* () { yield { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } })()
	}
})
await collect({ provider: 'opencode-argon', model: 'gemini-4-argon-contributor', messages: [USER], reasoningEffort: 'off' }, captureOff)
assert.deepEqual(offConfig.thinkingConfig, { thinkingBudget: 0, includeThoughts: true }, 'off → thinkingBudget 0')

/* ---------- 3. 失败分类 ---------- */
await assert.rejects(
	collect({ provider: 'opencode-argon', model: 'gemini-4-argon-contributor', messages: [USER] }, makeAdapter([{ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }])),
	(error) => error.code === 'EMPTY_RESPONSE' && error.failure.code === 'EMPTY_RESPONSE' && error.failure.message.length > 0,
	'零内容必须是 EMPTY_RESPONSE，且带可被 normalizeLlmFailure 采用的 failure 快照'
)

const auth = Object.assign(new Error('API key not valid'), { status: 401 })
await assert.rejects(
	collect({ provider: 'opencode-argon', model: 'gemini-4-argon-contributor', messages: [USER] }, makeAdapter([], { fail: auth })),
	(error) => error.code === 'AUTH' && error.failure.status === 401 && error.failure.code === error.code,
	'401 → AUTH，且 status 进快照'
)

const refused = Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
await assert.rejects(
	collect({ provider: 'opencode-argon', model: 'gemini-4-argon-contributor', messages: [USER] }, makeAdapter([], { fail: refused })),
	(error) => error.code === 'TRANSPORT',
	'连接失败 → TRANSPORT（默认可重试）'
)

console.log('adapter selftest: all assertions passed')
