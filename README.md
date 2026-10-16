# OpenCode Go「Gemini 4 Argon」接入 DSH（原生适配器插件）

## 结论

`gemini-4-argon-contributor` 现已作为 DSH 的一等 provider 路由可用：

```
DSH (ctx.llm.registerAdapter) → adapter/index.mjs
  → POST https://opencode.ai/inference/go/v1/models/gemini-4-argon-contributor:streamGenerateContent?alt=sse
       headers: x-goog-api-key: <key>, x-opencode-session: <固定 UUID>
```

在 GUI 模型选择器里选 **Gemini 4 Argon (OpenCode Go)**；子代理侧就是
`--provider opencode-argon --model gemini-4-argon-contributor`。

## 为什么必须是插件而不是配置

OpenCode Go 把 argon 只挂在 Google `generateContent` 协议下（`chat/completions`、`/responses`、
`/messages` 全部 400 `ModelProtocolUnsupported`），而 DSH 的 `dsh-llm-pi-ai` 只实现
`openai-completions` / `openai-responses` / `anthropic-messages` 三种协议，配置里写不进第四种。
DSH 的插件面提供了真正的修法：`ctx.llm.registerAdapter(routes, adapter)` —— 自己实现适配器，
直接说 Gemini 协议。这也是 TauriTavern [#358](https://github.com/Darkatse/TauriTavern/issues/358)
那条绕行方案的等价物。

## 文件

| 文件 | 角色 |
| --- | --- |
| `adapter/index.mjs` | 插件入口 + 原生 Gemini 适配器（`providerInfo` / `providerRetryPolicy` / `imageRequestPricing` / `listModels` / `resolveModel` / `prepareCall` / `stream`） |
| `adapter/selftest.mjs` | 不发网络的自检：chunk 序列、请求体映射、签名回放、失败分类 |
| `gemini-client.mjs` | 协议层：REST/SSE、thinking 档位、钥匙解析（`x-opencode-session` 也在这里加） |
| `session-id` | 复用的 `x-opencode-session` UUID（网关按它路由，没有它直接 400 `MissingSessionID`） |
| `docs/dsh-adapter-contract.md` | DSH 0.2.0-rc.2 的适配器契约速查（chunk 词汇表、错误旁路、模型元数据校验、注册陷阱） |
| `LICENSE` | MIT |

## 用法与排查

```bash
# 自检（不需要联网、不需要 DSH）
node ~/.dsh/opencode-argon/adapter/selftest.mjs

# 路由是否注册（取输出里最后一行 JSON 的 providers/models）
dsh --profile subagent --print-model-catalogue

# 端到端一轮（会真的调模型）
dsh --profile subagent --prompt "只读任务：列出当前目录顶层文件个数" \
    --provider opencode-argon --model gemini-4-argon-contributor --reasoning-effort medium
```

钥匙来源：请求显式传入 → `OPENCODE_GO_API_KEY` → `~/.local/share/opencode/auth.json` 的
`opencode-go.key`。DSH 的凭据里那份 `OPENCODE_GO_API_KEY`（`~/.dsh/.credentials.yaml`）已不再被本路由读取，
留着不影响；插件用的是 OpenCode 自己的 auth.json（缺文件时才需要环境变量）。

## DSH 侧改动

两个 profile 各两处（改前备份 `*.bak-bridge-20261016-135611`）：

- `~/.dsh/profiles/desktop/cordis.patch.yml`：`llm-pi-ai.providers` 里**删掉** `opencode-argon`
  （同名路由同时出现在配置和插件里会抛 `DUPLICATE_ADAPTER`，且同层条目并发挂载、行序不保证），
  文件末尾追加：

  ```yaml
  - insert:
      - id: llm-opencode-argon
        name: "file:///C:/Users/<USER>/.dsh/opencode-argon/adapter/index.mjs"
  ```

- `~/.dsh/profiles/subagent/cordis.patch.yml`：同样两处（叶子 profile，`dsh_task` / `dsh --profile subagent` 用）。
- `subagent-model-selection-settings.allowedModels` 里的 `opencode-argon / gemini-4-argon-contributor`
  保持不变（路由名与模型 id 都没变）。

## 踩过的坑（写插件必看）

1. **第三方插件 import 不到宿主包**：`@earendil-works/pi-ai`、`@deepseek-ai/dsh-llm` 从 `~/.dsh` 下的
   `file:///` 插件里全部 `ERR_MODULE_NOT_FOUND`（`profiles/node_modules` 里的 junction 还指着已失效的
   `C:\Program Files\DSH Desktop\...`）。所以 chunk 词汇表与错误码只能照源码硬编码。
2. **`registerAdapter` 会逐个检查方法存在**：只实现 `providerInfo`/`listModels`/`resolveModel`/`stream`
   会报 `adapter.providerRetryPolicy is not a function`。基类的默认实现拿不到，必须自己补齐
   `providerRetryPolicy` / `imageRequestPricing` / `prepareCall`。
3. **`prepareCall` 里的 `resolveModel` 必须 await**：DSH 的 `normalizeModelInfo` 直接读
   `provider`/`id`/`name`，拿到 Promise 就判 `INVALID_MODEL_INFO`。
4. **`listModels` 决定 GUI 可见性**：GUI 提交时强制"目录成员资格"，不列出模型就选不了。
5. **错误要自带 `failure` 快照**：不 import `LlmError` 也能保住 code，条件是自有数据属性
   `code` 与 `failure.code` 一致（否则降级 `UNKNOWN`）。
6. **`x-opencode-session` 必须有**：网关缺这个头直接 400。
7. **thinking 档位**：`thinkingLevel: minimal` 会被上游拒（400），所以 `minimal` 映射成 `low`；
   `off/none` 映射成 `thinkingBudget: 0`；`includeThoughts: true` 常开，thought part 变成 `reasoning-delta`。

## 验证记录（2026-10-16）

- `adapter/selftest.mjs`：全断言通过（chunk 序列与组装不变量、工具结果回填、schema 裁剪、
  `minimal→low`、`off→thinkingBudget 0`、签名回放、`EMPTY_RESPONSE`/`AUTH`/`TRANSPORT` 分类）。
- 叶子登记表：`--print-model-catalogue` 输出 `opencode-argon → gemini-4-argon-contributor`。
- 端到端：`--provider opencode-argon` 跑完带工具的只读任务，`stopReason: completed`，答案正确（24 个文件）。
- desktop patch 经 js-yaml 校验：14 个顶层条目，末条是本插件，`llm-pi-ai` 已无 `opencode-argon`。

## 已退役的桥接层

之前那版"本机回环桥接 + OpenAI 翻译"（`bridge.mjs` 监听 127.0.0.1:8787）已停用并移走：

- 文件在 `D:\Stash\2026-10-16\Users\<USER>\.dsh\opencode-argon\`（`bridge.mjs`、`start.cmd`、
  `selftest.mjs`、`translate.mjs`）；
- 开机自启快捷方式也从 `…\Startup\` 移到了
  `D:\Stash\2026-10-16\Users\<USER>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\`；
- 8787 端口已释放。

要回退：把这两个 profile 的 `*.bak-bridge-20261016-135611` 还原，并把上述文件搬回原位、重新建快捷方式。

## 已知边界

- **图片**：路由声明纯文本（`inputModalities: ['text']`）。Gemini 的 `inlineData` 映射没实现
  （需要 `attachments.readImageRequest` 取字节）；等确认 argon 视觉能力再开。
- **`stop` 序列**：`GenerateOptions.stop` 明确不支持，传了就抛 `UNSUPPORTED_OPTION`（DSH 目前不会传）。
- **`Retry-After`**：429 只映射成 `RATE_LIMIT`，没有转 `providerRetryAfterMs`；走默认退避。
- **上下文窗口/最大输出**按 Gemini 3 量级声明（1,048,576 / 65,536）；若上游实际更小，会以
  `CONTEXT_WINDOW_EXCEEDED` / `INVALID_REQUEST` 的形式暴露。
- **DSH 升级风险**：适配器契约与 chunk 词汇表是照 0.2.0-rc.2 硬编码的，升级后重跑
  `selftest.mjs` 与端到端那一条命令即可确认。
