/**
 * OpenCode Go 网关的 Gemini 路由客户端（原生适配器用；与 bridge.mjs 共用同一套协议知识）。
 *
 *   POST {base}/models/{model}:generateContent
 *   POST {base}/models/{model}:streamGenerateContent?alt=sse
 *
 * 约束（TauriTavern#358 实测）：必须带 x-opencode-session；只支持 Google generateContent 协议。
 */
import { readFileSync } from "node:fs"

export const DEFAULT_BASE = "https://opencode.ai/inference/go/v1"

/** DSH 的 reasoning 档位 → Gemini thinkingConfig（argon 不接受 thinkingLevel: minimal，会 400）。 */
export const THINKING_LEVELS = {
	none: { thinkingBudget: 0 },
	off: { thinkingBudget: 0 },
	minimal: { thinkingLevel: "low" },
	low: { thinkingLevel: "low" },
	medium: { thinkingLevel: "medium" },
	high: { thinkingLevel: "high" },
	xhigh: { thinkingLevel: "high" },
	max: { thinkingLevel: "high" }
}

/** thinking 档位 → generationConfig.thinkingConfig；未映射的档位返回 undefined。 */
export function thinkingConfigFor(effort) {
	if (typeof effort !== "string") return undefined
	const mapped = THINKING_LEVELS[effort.toLowerCase()]
	return mapped === undefined ? undefined : { ...mapped, includeThoughts: true }
}

/** 钥匙：显式传入 → 环境变量 → OpenCode 自己的 auth.json。 */
export function resolveApiKey(explicit) {
	if (typeof explicit === "string" && explicit.length > 0) return explicit
	if (process.env.OPENCODE_GO_API_KEY) return process.env.OPENCODE_GO_API_KEY
	const authFile = process.env.OPENCODE_AUTH_FILE
		?? `${process.env.USERPROFILE ?? process.env.HOME ?? ""}/.local/share/opencode/auth.json`
	try {
		return JSON.parse(readFileSync(authFile, "utf8"))["opencode-go"]?.key
	} catch {
		return undefined
	}
}

/** SSE 逐帧解析 Gemini 响应；Gemini 没有 [DONE] 终止帧。 */
async function* geminiEvents(body) {
	const decoder = new TextDecoder()
	let buffer = ""
	for await (const chunk of body) {
		buffer += decoder.decode(chunk, { stream: true })
		let index
		while ((index = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, index).trim()
			buffer = buffer.slice(index + 1)
			if (!line.startsWith("data:")) continue
			const data = line.slice(5).trim()
			if (data.length === 0 || data === "[DONE]") continue
			try {
				yield JSON.parse(data)
			} catch {
				// 半个 JSON 帧，丢弃（Gemini 的帧总是整个 data 行）
			}
		}
	}
}

/** 上游错误 → 带状态码与原始消息的 Error。 */
export async function upstreamError(response) {
	const text = await response.text()
	let message = text.slice(0, 600)
	try {
		const parsed = JSON.parse(text)
		message = parsed?.error?.message ?? parsed?.error?.type ?? message
	} catch {
		// 非 JSON 错误体，保留原文
	}
	const error = new Error(message || `upstream HTTP ${response.status}`)
	error.status = response.status
	error.upstream = text.slice(0, 2000)
	return error
}

/**
 * 调 Gemini 路由。
 * @param options.baseURL 网关基址（含 /v1）
 * @param options.model 模型 id
 * @param options.apiKey 钥匙（缺省时回退到本地 auth.json）
 * @param options.sessionId x-opencode-session 的值
 * @param options.body Gemini 请求体
 * @param options.stream 是否走 streamGenerateContent
 * @param options.signal 取消信号
 * @param options.extraHeaders 额外请求头（DSH 的 attribution headers）
 * @returns 流式时返回 Gemini 事件异步迭代器；非流式返回响应 JSON
 */
export async function callGemini(options) {
	const { model, body, stream, signal, sessionId, extraHeaders } = options
	const apiKey = resolveApiKey(options.apiKey)
	if (apiKey === undefined) {
		const error = new Error("no OpenCode API key: pass apiKey, set OPENCODE_GO_API_KEY, or create ~/.local/share/opencode/auth.json")
		error.status = 401
		throw error
	}
	const base = (options.baseURL ?? DEFAULT_BASE).replace(/\/+$/, "")
	const method = stream ? "streamGenerateContent" : "generateContent"
	const response = await fetch(`${base}/models/${encodeURIComponent(model)}:${method}${stream ? "?alt=sse" : ""}`, {
		method: "POST",
		signal,
		headers: {
			"content-type": "application/json",
			"x-goog-api-key": apiKey,
			"x-opencode-session": sessionId,
			...(stream ? { accept: "text/event-stream" } : {}),
			...extraHeaders
		},
		body: JSON.stringify(body)
	})
	if (!response.ok) throw await upstreamError(response)
	return stream ? geminiEvents(response.body) : await response.json()
}
