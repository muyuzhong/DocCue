# DocCue

> Turn static docs into context-aware in-app cues.

DocCue 是一个嵌进 Web 应用里的 AI 助手：用户**第一次进来时带着走一遍引导**，用户**卡住时结合他刚才在界面上做了什么来答疑**，还能直接在页面上高亮控件、帮用户填好正确的值。

它不是一套完整的客服系统，而是一个**开箱即用的快捷 Agent**：接入 Skill + 前端 SDK + 后端 handler。登录鉴权、数据库、部署这些开发者系统里本来就有的能力，DocCue 不重复造。

> **当前状态**：第一阶段（agent 核心）已完成，并用真实模型验证过。前端 SDK（bridge）、HTTP 传输层、工具（文档检索等）、页面动作、首次引导还在开发中，尚未发布到 npm。详见[路线图](#路线图)。

## 它怎么知道用户做了什么

前端 SDK（bridge）会像无埋点分析一样，自动记录用户的操作和每一步引起的结果，整理成模型能读的格式。用户提问时，模型会在对话末尾看到一份**状态栏**：

```text
<status time="19:02:20">
页面：新建数据源（/datasource/new）
当前报错：Invalid Host Format（输入框「主机地址」）
最近操作：
19:02:15 填写 输入框「主机地址」 = "http://127.0.0.1:5432"
19:02:18 点击 按钮「测试连接」 → 出现报错「Invalid Host Format」
</status>
```

用户只问了一句"为什么连不上？"，模型就能直接指出：主机地址里多了 `http://`，端口应该填在单独的输入框里。

几个设计上的要点：

- **只追加**：状态有变化时才在末尾追加一份新的状态栏，旧的不删。改动已经发给模型的历史，会让提示词缓存失效，在 Claude 新模型上还会让之前的思考块失效并报错。
- **事件驱动**：每个会话一个队列，回答进行中，界面事件照样更新状态，取消立刻生效；用户中途追问会排队，历史顺序始终和模型看到的一致。
- **与平台无关**：agent 核心只认"事件时间线 + 界面树 + 截图"这一种格式，网页、Electron、WebView 客户端的 bridge 都整理成它。

## 快速开始

需要 Node.js 22+ 和 pnpm 11。

```bash
git clone https://github.com/muyuzhong/DocCue.git
cd DocCue
pnpm install
cp .env.example .env    # 填入模型的 key，说明见 .env.example
pnpm chat
```

`pnpm chat` 是一个多轮对话的命令行，可以用命令模拟 bridge 上报的界面操作，在没有前端的情况下体验状态栏的效果：

```text
/page /datasource/new 新建数据源
/do input 输入框「主机地址」 = http://127.0.0.1:5432
/do click 按钮「测试连接」 -> 出现报错「Invalid Host Format」
/error Invalid Host Format
为什么连不上？
```

`/status` 查看现在的状态栏，`/history` 查看会话里存了什么，`/help` 列出全部命令。回答中可以继续输入（会排队），Ctrl-C 停止当前回答。

其他脚本：

| 命令 | 作用 |
| :--- | :--- |
| `pnpm try [--tool] "问题"` | 跑单轮；`--tool` 挂一个查时间的演示工具，测多步循环 |
| `pnpm chat` | 多轮对话，日志写到 `packages/core/.logs/` |
| `pnpm replay <日志> [编号]` | 列出日志里的模型调用；带编号则把那次调用原样重发，对比前后两次回答 |
| `pnpm test` / `pnpm typecheck` / `pnpm build` | 测试 / 类型检查 / 构建 |

## 作为库使用

```ts
import { createAnthropic, createScheduler, parseInbound, statusContext, withRetry } from '@doccue/core';

const scheduler = createScheduler({
  model: withRetry(createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, model: 'claude-opus-5-5' })),
  context: statusContext({ instructions: '你是「数据平台」的应用内助手，帮用户上手和解决使用中的问题。' }),
});

// 订阅输出：开始、状态、文字片段、结束、错误
scheduler.subscribe('session-1', (output) => {
  if (output.type === 'text') process.stdout.write(output.delta);
  if (output.type === 'turn_end') console.log(`\n[${output.reason}]`);
});

// 界面上发生的事（将来由 bridge 上报，现在可以手动构造）
await scheduler.push('session-1', {
  type: 'perception',
  page: { path: '/datasource/new', title: '新建数据源' },
  timeline: [
    { at: Date.now(), kind: 'input', target: '输入框「主机地址」', value: 'http://127.0.0.1:5432' },
    { at: Date.now(), kind: 'click', target: '按钮「测试连接」', result: '出现报错「Invalid Host Format」' },
  ],
  errors: [{ text: 'Invalid Host Format', target: '输入框「主机地址」' }],
});

// 用户提问：触发一轮回答，模型会在状态栏里看到上面这些
await scheduler.push('session-1', { type: 'user_message', content: '为什么连不上？' });
await scheduler.idle('session-1');

// 在自己的 HTTP 路由里接收 bridge 的数据：先校验，再交给调度层
export async function handleEvents(request: Request): Promise<Response> {
  const parsed = parseInbound(await request.json());
  if (!parsed.ok) return Response.json({ errors: parsed.errors }, { status: 400 });
  for (const event of parsed.value.events) await scheduler.push(parsed.value.sessionId, event);
  return new Response(null, { status: 204 });
}
```

鉴权、限流由你在自己的路由和中间件里处理；会话默认存在进程内存，可以通过 `store` 换成自己的存储。

## 模型接入

运行时零依赖，直接用原生 `fetch` 对接接口：

| 适配器 | 适用 | 说明 |
| :--- | :--- | :--- |
| `createAnthropic` | Claude 模型（官方接口或中转） | API 版本 `2026-10-21`；思考块原样回传；官方地址下默认开启自动提示词缓存、工具参数流式传输，以及拒答自动换模型（限 claude-opus-5-5 等支持的模型），走中转时默认关闭 |
| `createOpenAI` | OpenAI，以及所有 OpenAI 兼容接口（Ollama、vLLM、LM Studio、各类网关） | 相邻的用户消息会合并，兼容要求角色交替的本地模型 |

两者都支持：60 秒收不到任何数据就断开（心跳包也算数据）、`withRetry` 对限流和服务端错误自动重试（只在还没输出时重试）、通过 `withModelLog` 记录每次调用的完整请求和耗时。

## 架构

项目按"从内到外"分层，外层依赖内层，内层不知道外层，比如核心循环既不知道 HTTP，也不知道 bridge 跑在网页还是客户端里。

```text
外圈  开发者系统（鉴权、持久化、部署，不归 DocCue）
 └ 9  接入 Skill（开发期，可选）           ⏸
    └ 8  bridge（嵌在宿主应用里）            ⏸
       └ 7  传输：HTTP + SSE                 ⏸
          └ 6  协议：校验输入事件            ✅
             └ 5  调度：事件队列 · 触发器    ✅
                └ 4  状态：会话              ✅
                   └ 3  上下文：状态栏       ✅
                      └ 2  工具              ⏸
                         └ 1  核心循环       ✅
                            └ 0  模型        ✅
横切：配置 · 日志与回放 · 错误与超时         ✅
```

每层的细节见 [project_structure.md](project_structure.md)，完整设计见 [architecture_design.md](architecture_design.md)。

## 目录结构

```text
packages/core/
  src/
    model/       模型适配器、流式解析、重试
    loop/        核心循环：调模型 → 执行工具 → 再调模型
    context/     上下文：system prompt、状态栏
    state/       会话状态、存储接口
    scheduler/   事件队列、触发器
    protocol/    输入校验
    log/         日志与回放
  scripts/       try / chat / replay
  test/          测试
architecture_design.md   架构设计
project_structure.md     分层结构与进度
```

## 路线图

- [x] **第一阶段：agent 核心**。模型适配、核心循环、上下文与状态栏、会话状态、事件调度、输入协议、日志与回放、超时与重试。
- [ ] **第二阶段：打通真实网页**。HTTP + SSE 传输层、最小 bridge（只做感知：操作记录、控件命名、界面树、报错采集）、playground 演示页面。
- [ ] **工具**：`get_screen` / `get_timeline` 按需查看、截图、产品文档检索。
- [ ] **页面动作**：高亮控件、一键代填。
- [ ] **首次引导**：静态剧本 + AI 个性化引导，引导中可以随时提问。
- [ ] **接入 Skill**：扫描宿主源码，给命名不准的控件补名字，生成控件说明和引导剧本。

暂不做：脱敏、内置向量检索（RAG）、原生客户端（Qt、WPF、安卓/iOS 原生等）的 bridge。
