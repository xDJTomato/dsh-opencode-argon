# DSH LLM 适配器契约速查（0.2.0-rc.2）

本文是写第三方 DSH LLM 适配器时需要的宿主契约要点，供本仓库的 `adapter/index.mjs` 对照。
所有结论来自对 `dsh-llm` 0.2.0-rc.2 解包源码的阅读；DSH 处于 rc 阶段，升级后请以源码为准。

## 1. 插件入口与注册

```js
export const name = 'llm-opencode-argon'
export const inject = ['llm']
export function apply(ctx, config) {
  ctx.llm.registerAdapter(['my-route'], adapter)   // 返回 disposer（带 .replace）
}
```

- `name` / `Config` / `inject` 是元数据；真正被调用的是 `apply(ctx, config)`。
- 缺 `inject: ['llm']` 时读 `ctx.llm` 会抛 `cannot get property "llm" without inject`。
- 同一路由名被注册两次 → 后注册者 `DUPLICATE_ADAPTER`，整批不提交。**同一层内的条目并发挂载，行序不保证**，所以别指望"先注册先赢"：同名路由要么由配置给，要么由插件给。
- 路由**不需要**写进 `llm-pi-ai` 的 `providers` 配置；插件注册的路由会出现在 `llm.listProviders()` 里。

## 2. 适配器必须实现的方法

`registerAdapter` 会逐个检查实例方法是否存在——缺一个就抛 `adapter.<name> is not a function`。
基类 `LlmAdapter` 只给 `providerInfo` / `providerRetryPolicy` / `imageRequestPricing` / `listModels` / `resolveModel` / `prepareCall` 提供默认实现，第三方插件拿不到基类，必须自己补齐：

| 方法 | 说明 |
| --- | --- |
| `providerInfo(provider)` | 返回 `{ id, name }`，`id` 必须等于传入的 provider |
| `providerRetryPolicy(provider)` | 返回 `undefined` 即用宿主默认重试策略 |
| `imageRequestPricing(provider, model)` | 同步返回，不声明就返回 `undefined` |
| `listModels(provider)` | 广告模型清单；**GUI 成员资格由它决定** |
| `resolveModel(provider, model, signal)` | 精确模型元数据（见 §5） |
| `prepareCall(provider, model, signal)` | 返回 `{ model, stream }`，`model` 必须已解包 |
| `stream(options)` | 返回异步可迭代的 chunk 流（异步生成器最省事） |

## 3. `stream(options)` 的入参

```ts
interface GenerateOptions {
  provider: string
  model: string
  reasoningEffort?: string
  messages: RequestMessage[]
  system?: string
  tools?: { name: string; description?: string; parameters: unknown }[]
  toolHistory?: unknown
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal
  sessionId?: string
  purpose?: 'compaction' | 'session-title'
}
```

- **没有 `toolChoice`、没有 `attachments`、没有 `systemPrompt`、没有 `callConfig`。**
- 系统提示词多数情况下以 `role: 'system'` 消息出现在 `messages` 里，同时 `options.system` 也可能是辅助调用方填的字符串——两处都要合并。
- 图片不在 options 里，字节要从附件服务取（本适配器暂不支持图片）。
- 内容块类型：`text` / `reasoning` / `image` / `file` / `tool-call`（`arguments` 是 **原始 JSON 字符串**）；工具结果是一条独立的 `role: 'tool'` 消息，带 `toolCallId` 与 `isError`。

## 4. `stream()` 必须 yield 的 chunk

宿主没有 chunk 构造器，只有字面量联合（读侧工具如 `assistantStreamChunks` / `BlockAssembler` 不负责造 chunk）：

| type | 字段 |
| --- | --- |
| `block-start` | `index`, `blockType` |
| `text-delta` | `index`, `text` |
| `reasoning-delta` | `index`, `text` |
| `tool-call-delta` | `index`, `id`, `argumentsDelta`, `name?`（通常只在首个 delta 带 `name`） |
| `block-end` | `index`, `block`（**累积后的完整块**） |
| `usage` | `usage`（`inputTokens` / `outputTokens` / `totalTokens`） |
| `finish` | `reason` = `{ kind: 'stop' \| 'tool-calls' \| 'max-tokens' }` 或 `{ kind: 'error' \| 'aborted', failure }` |

顺序与终局不变量：

- 每个 `block-start` 对应一个 `block-end`，`index` 单调递增；delta 先累积、`block-end` 再给完整内容。
- 每个流**恰好一个** `usage` 与一个 `finish`；`usage` 在 `finish` 之前，`finish` 之后不得再 yield。
- 自然结束（不发 `finish`）也会被当作 `stop`，但显式发更稳。
- 工具是否执行由**内容块**决定，不由 `finish.kind` 决定；只有 `max-tokens` 会让宿主丢弃 tool-call 块。
- `adapterStream` 本身不校验 chunk 形状，校验在消费侧（未知 `type` 走 `assertNever` 直接抛）。

## 5. `resolveModel` 的返回值

`normalizeModelInfo` 会逐字段校验：

- 必填：`provider`（等于入参）、`id`（等于入参）、`name`（非空）。
- 可选：`description`、`inputModalities`、`context: { contextWindow }`（正整数）、
  `defaultMaxTokens`（正整数；会被物化成请求的 `maxTokens`）、`systemPromptUpdate: 'in-history'`、
  `toolUpdate: 'in-history' | 'addition-only'`。
- `reasoning: { efforts: [{ id, name }], defaultEffort? }`：`efforts` 不能为空，且 `defaultEffort` 必须在其中。

`prepareCall` 里必须 **await** `resolveModel`——校验读的是 `provider`/`id`/`name` 三个属性，拿到 Promise 会判 `INVALID_MODEL_INFO`。

`listModels` 决定 GUI 能不能选中：宿主在提交时强制"目录成员资格"，不列出的模型选不了（核心路由本身不要求目录成员资格）。

## 6. 错误契约

- 抛出的错误只有 `HarnessError` 实例才保得住 `code`，否则降级 `UNKNOWN`。
- **合法旁路**：错误自带自有数据属性 `code` 与 `failure: { message, code, status?, providerRetryAfterMs?, requestId?, offloadImages? }`，
  且两者 `code` 一致时，宿主直接采用该快照。字段取值范围有校验（`status` 必须 100–599 等），任一不合规整个快照作废。
- 流已开始后也可以自己 yield `{ type: 'finish', reason: { kind: 'error', failure } }`。
- 默认可重试 code：`EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`。
- 常用 code：`AUTH`（401/403）、`QUOTA`（402/额度文案）、`RATE_LIMIT`（429）、
  `CONTEXT_WINDOW_EXCEEDED`、`INVALID_REQUEST`（400/413）、`SERVER`（5xx）、`HTTP_<status>`、
  `UNSUPPORTED_OPTION`、`MISSING_CREDENTIAL` / `INVALID_CREDENTIAL`（凭据缺失 vs 凭据不可用）、`ABORTED`。
- 正常结束但零内容块 → `EMPTY_RESPONSE`（唯一的"内容类可安全重试"失败）。

## 7. 归因请求头

`attributionHeaders()` 默认返回 `{ 'user-agent': 'deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)' }`，
文档要求**每个出网请求**都带上（无运行时强制）。第三方插件 import 不到这个函数，只能照抄其取值。
