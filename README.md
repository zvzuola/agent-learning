# Production Agent Learning

这是一个由 AI 生成和维护的个人学习项目，使用 JavaScript 与官方 [`@anthropic-ai/sdk`](https://www.npmjs.com/package/@anthropic-ai/sdk) 学习生产级 Agent 的设计和工程实践。

项目内容用于个人实验与知识整理，不代表官方教程或生产方案。课程索引见 [docs/README.md](docs/README.md)，完整路线见 [docs/00-learning-plan.md](docs/00-learning-plan.md)。

## 学习范围

- Agent 核心循环与运行边界
- 工具 Schema、业务校验、权限与副作用
- 运行预算、错误处理、取消与恢复
- 线程状态、Checkpoint、上下文与记忆
- 规划、人工审批、RAG、MCP 与多 Agent
- 轨迹评测、安全、可观测性与生产部署

`@anthropic-ai/sdk` 只作为底层模型依赖使用。认证、网络请求和响应格式不属于本教程内容。

## 快速开始

需要 Node.js 20+：

```powershell
npm install
npm test
```

Lesson 01 会自动读取系统 Claude 配置：

- 默认路径：`~/.claude/settings.json`
- 自动读取：认证信息、`ANTHROPIC_BASE_URL` 和模型配置
- 若 Claude 使用自定义配置目录，则沿用其 `CLAUDE_CONFIG_DIR`

无需在项目中设置 API Key 或模型环境变量，直接运行：

```powershell
npm run lesson:01 -- "Read package.json and summarize the project setup"
```

## 学习方式

1. 按课程索引阅读讲义并运行对应示例。
2. 先用确定性测试描述预期 Agent 轨迹，再修改实现。
3. 同时断言最终答案、工具调用、状态变化和副作用。
4. 每课使用生产检查表记录当前实现与上线要求的差距。

目标不是做一个“能聊天”的 Demo，而是构建可验证、可恢复、可治理的生产 Agent。
