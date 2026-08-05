# Lesson 01：Agent 核心循环

## 1. 本课目标

完成本课后，你应能：

- 使用 Anthropic SDK 装配一个可调用业务工具的 Agent。
- 解释 `决策 -> 行动 -> 观察 -> 再决策` 循环。
- 通过依赖注入隔离模型、数据库和外部服务。
- 区分模型失败、工具失败、预算耗尽和正常完成。
- 使用确定性测试验证完整 Agent 轨迹。

本课不学习模型通信协议。SDK 响应到 Agent 状态的转换由 `CodingAgent` 内部负责。

## 2. Agent 的职责边界

```text
User
  |
  v
CodingAgent
  +-- 维护运行状态
  +-- 请求模型决策
  +-- 校验并执行工具
  +-- 记录观察结果
  +-- 检查预算和停止条件
  |
  +---- Model SDK
  +---- ToolRegistry
  +---- CheckpointStore
  +---- EventSink
```

模型负责提出下一步，工具负责确定性业务动作，Agent Runtime 负责控制流程。数据库、HTTP Client 等基础设施通过工具依赖注入，不隐藏为全局状态。

## 3. 一次完整 Agent 轨迹

```text
1. 用户提出任务
2. Agent 请求模型决定下一步
3. 模型选择业务工具及参数
4. Agent 校验参数和运行预算
5. Agent 执行工具并记录结果
6. Agent 将新观察加入状态，再次请求决策
7. 模型给出最终回答，Agent 正常结束
```

关键不变量：每个已执行的工具请求都有对应结果；失败状态不会伪装成最终成功；只有完整结束的轮次才写入 Checkpoint。

## 4. 工具契约与双重校验

应用通过 `ToolRegistry` 注册业务工具：

```js
tools.register({
  name: 'read_project_file',
  description: 'Read a UTF-8 text file inside the current project.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1 },
    },
    required: ['path'],
    additionalProperties: false,
  },
  validate: (input) => fileSchema.parse(input),
  handler: ({ path }) => projectReader.readTextFile(path),
});
```

`inputSchema` 帮助模型生成参数，`validate` 在执行前建立应用自己的信任边界。任何模型生成的参数都必须视为不可信输入。

## 5. 失败是 Agent 状态的一部分

### 工具失败

未知工具、无效参数和业务异常会成为失败观察，模型可以修正参数、改用其他工具或向用户解释。是否允许重试、重试次数和写操作能否重复执行，必须由 Agent Policy 决定。

### 模型失败

模型调用异常返回 `model_error`，当前线程不会保存一个不完整的助手步骤。上层服务可据此执行重试、降级或告警。

### 非正常停止

输出截断、拒绝和上下文耗尽等情况保留独立状态，不包装成 `completed`。调用者因此能够采取与成功回答不同的处理策略。

## 6. 并行工具调用

模型可能在一次决策中请求多个工具。当前实现先检查整个批次是否超过 `maxToolCalls`，预算足够才并行执行，避免“执行一半才发现超预算”的部分副作用。

生产环境需要进一步区分：

- 只读工具：通常可以并行。
- 有副作用工具：需要审批、幂等键或串行事务。
- 共享资源工具：需要并发限制和租户隔离。

## 7. 运行预算

`CodingAgent` 当前实现：

- `maxSteps`：限制 Agent 决策轮数。
- `maxToolCalls`：限制业务工具总调用数。

Lesson 02 已加入单工具超时、重试分类、幂等和用户取消；墙钟总预算、Token 和金额预算留到后续课程。预算耗尽返回独立状态，不能生成看似成功的答案。

## 8. Checkpoint 与线程

`runThread(threadId, input)` 从 `CheckpointStore` 恢复历史，并且只在状态为 `completed` 时原子地保存整个轮次。模型错误、无效响应、预算耗尽和其他非正常停止都保留在本次返回值与事件中，不污染已提交的线程历史。相同线程可以继续任务，不同线程互相隔离。

当前 `InMemoryCheckpointStore` 只适合本地学习和测试。生产环境需要数据库实现，并补充：

- 租户与线程归属校验。
- 乐观锁或版本号，防止并发覆盖。
- 状态 Schema 迁移。
- 加密、保留期限和删除策略。

## 9. 测试 Agent 轨迹

Fake Client 隔离模型随机性，测试重点包括：

1. Agent 是否执行了正确工具和参数。
2. 无效参数是否在业务依赖调用前被拒绝。
3. 预算耗尽后是否没有产生部分副作用。
4. 模型或观测系统失败时状态是否明确。
5. 同一线程是否恢复、不同线程是否隔离。

运行：

```powershell
npm test
npm run lesson:01 -- "Read package.json and summarize the project setup"
```

课程要求 Lesson 示例使用真实 Anthropic Client，以便观察模型实际产生的决策、工具参数、观察结果、Token 用量和停止原因。示例自动读取 `~/.claude/settings.json` 中的认证、服务地址和模型配置，无需在项目中设置环境变量。真实模型输出具有随机性且可能产生调用费用；Fake Client 仅用于自动化测试，稳定验证 Agent 的分支、失败和副作用。

## 10. 动手实验

1. 新增 `write_project_file` 工具，要求修改前获得人工审批并保留原文件快照。
2. 新增未知工具场景，验证 Agent 能将失败反馈给模型继续决策。
3. 让两个只读工具并行执行，记录总耗时并与串行执行对照。
4. 增加 `maxDurationMs`，在每次决策和工具执行前检查墙钟预算。
5. 为工具传入 AbortSignal，证明取消后不会继续产生副作用。

## 11. 生产检查表

- [ ] 工具名称稳定，描述明确说明适用和禁用场景。
- [ ] 输入 Schema 拒绝额外字段，应用层再次校验参数。
- [ ] 每个工具请求都能关联到执行结果和运行 ID。
- [ ] 工具结果大小受限并经过敏感信息过滤。
- [ ] 写工具具有权限检查、审批和幂等策略。
- [ ] 并行调用不会造成竞态或部分副作用。
- [ ] 模型、工具、状态存储和观测失败具有不同状态。
- [ ] 工具、步骤、时间、Token 和成本都有预算。
