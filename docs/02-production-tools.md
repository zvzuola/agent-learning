# Lesson 02：生产级工具工程

## 1. 本课目标

完成本课后，你应该能够：

- 把模型可见的工具 Schema 与应用真正允许执行的 Tool Policy 分开。
- 为每个工具设置允许列表、单次超时和结果大小上限。
- 用稳定的错误码区分参数错误、策略拒绝、超时、取消、业务失败和基础设施失败。
- 为有副作用的操作设计幂等键，去重并发重放，拒绝同键不同参数。
- 理解“超时返回”不等于“远端副作用已经撤销”，并把 `AbortSignal` 传到真正的下游。

本课继续使用 `CodingAgent` 的模型适配边界。重点是工具执行层的应用可信边界，不是 Anthropic SDK 的通信协议。

## 2. 为什么工具需要第二道边界

工具定义里的 `inputSchema` 只回答“模型可以生成什么形状的参数”。它不能回答：

- 当前运行是否允许这个工具。
- 这个工具最多运行多久。
- 工具结果是否会撑爆上下文。
- 同一写请求重试会不会重复扣款、建单或发消息。
- 一个失败是否值得上层重试。

`ToolRegistry` 通过 `ToolPolicy` 解决这些问题。注册时先验证工具契约，执行时再解析策略：

```js
const tools = new ToolRegistry({
  policy: new ToolPolicy({
    allowedTools: ['submit_work_item'],
    defaultTimeoutMs: 1_000,
    defaultMaxResultBytes: 16 * 1024,
  }),
});

tools.register({
  name: 'submit_work_item',
  description: 'Submit one work item. This operation has side effects.',
  inputSchema: { /* model-facing JSON Schema */ },
  validate: (input) => schema.parse(input),
  policy: {
    timeoutMs: 500,
    idempotency: 'required',
  },
  idempotencyKey: ({ request_id }) => request_id,
  handler: async (input, { signal, idempotencyKey }) => {
    // Pass both values to the downstream API.
    return downstream.submit(input, { signal, idempotencyKey });
  },
});
```

工具被策略拒绝时不会出现在发给模型的工具定义里；如果模型已经持有旧定义并发起调用，执行层仍会返回 `policy_denied`，不会调用业务依赖。

## 3. 超时与取消

每次执行都会创建工具自己的 `AbortController`，并把它与调用方的 `AbortSignal` 合并：

- 到达 `timeoutMs`：返回 `timeout`，通常可重试。
- 用户或上层取消：返回 `cancelled`，通常不可重试。
- 工具处理器主动抛出 `ToolExecutionError`：使用它声明的业务 `code` 和 `retryable`。
- 其他异常：归类为 `execution_error`，默认不可重试。

工具必须真正监听 `signal` 并停止下游工作。注册表可以在超时后尽快结束 Agent 等待，但无法凭空撤销一个已经发到远端、且远端不支持取消的 HTTP 请求。因此有副作用的下游仍必须支持幂等键、事务或补偿查询。

工具结果也有 `maxResultBytes` 上限。超限返回 `result_too_large`，不把完整结果送入模型上下文。

## 4. 错误分类与重试

错误对象是模型可以观察到的 JSON：

```json
{
  "tool": "submit_work_item",
  "error": {
    "code": "service_unavailable",
    "message": "The work-item service is temporarily unavailable",
    "retryable": true
  }
}
```

`retryable` 是工具契约的一部分，不是模型看到网络异常后自行猜测的许可。推荐规则：

| 分类 | 默认是否可重试 | 典型处理 |
|---|---:|---|
| `tool_not_found` | 否 | 检查版本或工具注册 |
| `validation_error` | 否 | 修正输入后再决定 |
| `policy_denied` | 否 | 请求审批或改用允许工具 |
| `timeout` | 是 | 保持同一幂等键重试 |
| `cancelled` | 否 | 尊重用户取消 |
| 业务 `ToolExecutionError` | 由工具声明 | 依据错误码和重试预算 |
| `execution_error` | 否 | 告警、降级或人工处理 |
| `result_too_large` | 否 | 改用分页、摘要或过滤 |
| `result_serialization_error` | 否 | 修复工具返回契约，必须是 JSON 值 |
| `idempotency_store_read_error` | 是 | 副作用尚未执行，可在预算内重试 |
| `idempotency_store_write_error` | 否 | 副作用可能已完成，先查询状态或人工处理 |
| `idempotency_in_progress` | 是 | 另一实例正在执行，退避后查询或重试 |

模型可以根据观察继续决策，但运行时仍用 `maxToolCalls` 限制总调用量。后续课程会再加入墙钟总预算和更细的重试策略；本课不把“可重试”误当成“无限重试”。

## 5. 幂等与重复调用

幂等策略有四种：

- `none`：不缓存，也不要求键，适合明确的只读或无副作用工具。
- `optional`：有键则去重，没有键也可执行，适合迁移期工具。
- `required`：没有键直接拒绝，适合扣款、创建资源、发送通知等副作用。
- `cache`：使用工具校验后的输入生成规范化键，适合确定性的只读工具。

当工具声明 `required` 或 `optional` 时，可以实现 `idempotencyKey(input)`。注册表会：

1. 先完成 Schema/业务校验，再提取键。
2. 用原子 `claim` 抢占首次执行；同进程并发请求共享同一个执行 Promise。
3. 成功后缓存结果，后续同键调用返回 `replayed: true`。
4. 发现同键不同输入时返回 `idempotency_conflict`。
5. 工具失败不写入成功缓存，允许上层按策略重试。

幂等存储读取失败发生在工具执行前，可以安全地给出可重试提示；工具成功后若写入幂等结果失败，则副作用已经可能发生，返回不可重试的 `idempotency_store_write_error`。调用方应查询业务状态或进入人工处理，不能盲目重放。

默认的 `InMemoryIdempotencyStore` 只适用于单进程学习和测试。可替换 Store 必须实现原子的 `claim/complete/release` 契约：跨实例竞争只能有一个 `claimed`，其他实例得到 `in_progress`。生产环境应使用 Redis/Postgres 等共享存储实现，还要为崩溃后遗留的 claim 设计租约和业务状态核对。

注意：幂等键应代表业务操作，而不是模型生成的 `tool_use` ID。一次重试会产生新的模型调用 ID，但业务 `request_id` 必须保持不变。
如果调用上下文提供的键与工具从业务输入提取的键不一致，执行会返回 `idempotency_key_mismatch`。注册表会哈希原始键再交给 Store，降低业务标识直接出现在基础设施键空间中的风险。

## 6. 事件与 SDK 协议

`tool.completed` 事件会记录：工具名、工具调用 ID、是否错误、错误码、是否可重试、是否重放和耗时。运行时内部的 `metadata` 不会写入发送给 Anthropic 的 `tool_result`；发给模型的结果仍只包含 SDK 支持的标准字段。

这条边界很重要：观测字段可以随项目演进，模型消息协议则必须严格遵循 SDK/API 契约。

## 7. 运行示例

示例使用真实 Claude Client，并从系统配置读取认证和模型：

```powershell
npm run lesson:02
```

示例工具会故意让第一次提交失败一次。观察轨迹时应看到：第一次 `service_unavailable`，同一 `request_id` 的成功重试，以及成功后的重放调用。真实模型输出具有随机性并可能产生调用费用。

自动化测试不访问网络：

```powershell
node --test test/tools/tool-registry.test.js
npm test
```

## 8. 动手实验

1. 把 `submit_work_item` 换成扣款工具，尝试复用同一键但修改金额，确认得到 `idempotency_conflict`。
2. 写一个不监听 `signal` 的慢工具，观察 Agent 虽然能超时返回，但底层 Promise 仍会继续；再修复它。
3. 实现一个 Redis/Postgres 版本的 `idempotencyStore`，为并发首次请求增加原子占位。
4. 给工具增加租户作用域，让存储键至少包含 `tenantId`，并测试跨租户不能重放。
5. 为结果分页设计新的工具，而不是简单提高 `maxResultBytes`。

## 9. 生产检查表

- [ ] 工具定义和策略分别评审；允许列表默认最小化。
- [ ] 工具参数经过模型 Schema 和应用业务校验两次边界检查。
- [ ] 每次调用都有运行 ID、工具调用 ID、耗时和分类结果。
- [ ] 错误码稳定，`retryable` 由工具/策略声明，不由模型猜测。
- [ ] 超时、取消信号已经传到实际下游，并验证下游的停止行为。
- [ ] 有副作用的工具要求业务幂等键，并把键透传到下游。
- [ ] 相同键的并发调用只执行一次，同键不同输入会冲突。
- [ ] 失败不会污染成功幂等缓存，重试次数仍受运行预算限制。
- [ ] 结果大小受限；敏感信息过滤和分页策略已经定义。
- [ ] 单进程内存 Store 已替换为跨实例原子共享存储。
