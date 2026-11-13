# DocCue

> Turn static docs into context-aware in-app cues.

复杂的应用上手慢，文档又放在官网上。DocCue 是**新手引导的 agent 版**：嵌在你的 Web 应用里，用户问"怎么做"或"为什么不行"，它结合用户刚才在界面上做了什么来回答，并在页面上一步步指给用户看。

- **只指不做**：agent 不操控应用，不替用户点击和填写。
- **只在被问到时出现**：不主动打扰。
- **接入简单**：前端加一个包，后端挂一个接口。登录鉴权、数据库、部署这些你的系统里本来就有的能力，DocCue 不重复造。

> **当前状态**：答疑和单个页面内的可视引导已经可用，并在真实浏览器 + 真实模型上端到端验证过。跨页面引导、文档检索、自带问答窗还在开发中，尚未发布到 npm。详见[路线图](#路线图)。

## 它怎么知道用户做了什么

前端的 bridge 像无埋点分析一样，自动记录用户的操作和每一步引起的后果，连同当前界面一起上报。用户提问时，模型看到的是：

```text
<context locale="zh-CN">
recent actions:
5s ago: input textbox "主机地址" = "http://127.0.0.1:5432"
2s ago: click button "测试连接" -> error "Invalid Host Format" on textbox "主机地址"
screen:
page "新建数据源" /datasource/new
[5] heading "新建数据源"
[6] form "连接信息"
  [9] textbox "主机地址" = "http://127.0.0.1:5432" (invalid)
  alert "Invalid Host Format"
  [10] textbox "端口" = "5432"
  [14] button "测试连接"
  [15] button "保存" (disabled)
</context>
为什么连不上？
```

用户只问了一句"为什么连不上？"，模型就能直接指出：主机地址里多了 `http://`，端口应该填在单独的输入框里。

然后它在页面上指给用户看：压暗其余部分，高亮「主机地址」输入框，旁边的气泡写着该怎么改。用户改完，气泡自动移到「测试连接」按钮上；连上之后，模型看到"连接成功"的提示，确认问题解决。

几个设计上的要点：

- **后端无状态**：对话记录放在浏览器，每次请求整份带上。后端可以部署在任何地方，包括无服务器平台。
- **历史只追加**：已经发给模型的内容从不改动，提示词缓存一直命中，Claude 的思考块也保持有效。
- **与语言无关**：前端上报结构化数据，控件的角色用 ARIA 的英文词，名字保留界面原文；模型的回答跟随用户的语言。
- **编号指向控件**：界面里每个控件有一个编号，模型用编号指向它，所以只能指它确实见过的东西。
- **引导的结果回到模型**：用户做了什么、跳过了哪步、界面变成了什么样，模型都看得到，能确认做成了，也能改道。

## 快速开始

需要 Node.js 22+ 和 pnpm 11。

```bash
git clone https://github.com/muyuzhong/DocCue.git
cd DocCue
pnpm install
cp .env.example .env    # 填入模型的 key，说明见 .env.example
pnpm playground         # 打开 http://localhost:5173
```

playground 是一个模拟的「数据平台」，右侧是问答框。试试：进入「新建数据源」，主机地址填 `http://127.0.0.1:5432`，点「测试连接」，然后问「为什么连不上？」，跟着页面上的气泡改。问答框下面的「agent 看到了什么」会实时显示 bridge 记下的操作，以及提问时模型看到的现场信息。

不想开浏览器的话，`pnpm chat` 是一个多轮对话的命令行，可以用命令模拟 bridge 上报的界面操作：

```text
/page /datasource/new 新建数据源
/do input textbox 主机地址 = http://127.0.0.1:5432
/do click button 测试连接 -> Invalid Host Format
为什么连不上？
```

`/context` 查看下一次提问会带上的现场信息，`/reset` 开始新对话，`/help` 列出全部命令。回答中 Ctrl-C 停止当前回答。

其他脚本：

| 命令 | 作用 |
| :--- | :--- |
| `pnpm playground` | 演示应用，日志写到 `apps/playground/.logs/` |
| `pnpm --filter @doccue/playground e2e` | 用本机 Chrome 自动操作演示应用并提问，跟着引导走，打印模型看到的内容和回答 |
| `pnpm eval [名字片段]` | 用真实模型跑评测场景：给定页面和问题，引导的第一步有没有指对控件 |
| `pnpm try [--tool] "问题"` | 跑单轮；`--tool` 挂一个查时间的演示工具，测多步循环 |
| `pnpm chat` | 多轮对话，日志写到 `packages/core/.logs/` |
| `pnpm replay <日志> [编号]` | 列出日志里的模型调用；带编号则把那次调用原样重发，对比前后两次回答 |
| `pnpm test` / `pnpm typecheck` / `pnpm build` | 测试 / 类型检查 / 构建 |

## 作为库使用

**后端**：把处理函数挂到你的服务上。

```ts
import { createHandler, createModelFromEnv, withRetry } from '@doccue/core';
import { toNodeHandler } from '@doccue/core/node';

const handler = createHandler({
  model: withRetry(createModelFromEnv(process.env)),
  instructions: '你是「数据平台」的应用内助手，帮用户上手和解决使用中的问题。',
  basePath: '/doccue',
});

// Express / Connect / node:http；Fetch 风格的框架（Hono、Next.js 路由等）直接用 handler
app.use('/doccue', toNodeHandler(handler));
```

**前端**：一行接入 bridge，再把你的问答框接上去。

```ts
import { createBridge } from '@doccue/bridge';

const cue = createBridge({ endpoint: '/doccue' });   // 从这一行开始记录用户操作

cue.on('text', (event) => console.log(event.delta));  // 流式回答
cue.on('end', (event) => console.log(event.reason));
cue.on('guide_end', (event) => console.log(event.outcome));   // 页面上的一段引导结束

// 用户在你的问答框里提问时：连同记录下的操作和当前界面一起发给 agent
await cue.ask('为什么连不上？');   // 回答需要指给用户看时，bridge 会自己在页面上引导
cue.stop();     // 停止当前回答，关掉页面上的引导
cue.reset();    // 开始新对话
```

问答框本身要加 `data-cue-ignore`，免得用户在里面打字也被当成操作记下来。bridge 平时只在浏览器本地记录，提问时才上传；密码只记"填写过"，不记内容。

接口是开放的，鉴权和限流由你在自己的路由和中间件里处理。后端不保存对话：对话记录在浏览器的 sessionStorage 里，每个标签页一份。

## 模型接入

运行时零依赖，直接用原生 `fetch` 对接接口：

| 适配器 | 适用 | 说明 |
| :--- | :--- | :--- |
| `createAnthropic` | Claude 模型（官方接口或中转） | API 版本 `2026-10-21`；思考块原样回传；官方地址下默认开启自动提示词缓存、工具参数流式传输，以及拒答自动换模型（限 claude-opus-5-5 等支持的模型），走中转时默认关闭 |
| `createOpenAI` | OpenAI，以及所有 OpenAI 兼容接口（Ollama、vLLM、LM Studio、各类网关） | 相邻的用户消息会合并，兼容要求角色交替的本地模型 |

两者都支持：60 秒收不到任何数据就断开（心跳包也算数据）、`withRetry` 对限流和服务端错误自动重试（只在还没输出时重试）、通过 `withModelLog` 记录每次调用的完整请求和耗时。

## 架构

agent 在后端，但它要用的东西（界面、用户的操作、以后的可视引导）大多在浏览器里。所以后端只做一件事：收到完整的对话记录，调模型，流式返回。

| 前端 `@doccue/bridge` | 后端 `@doccue/core` |
| :--- | :--- |
| 感知：记录操作及其后果，生成界面快照 | 渲染：把对话记录转成给模型的消息 |
| 引导：聚光灯、气泡、步骤推进 | 循环：调模型，执行后端工具，遇到 `guide` 就交给前端 |
| 对话：保存记录、发请求、执行引导并回传结果 | 模型适配、日志与回放 |

两边交换的数据定义在 `@doccue/protocol`。完整设计见 [architecture_design.md](architecture_design.md)，代码结构和进度见 [project_structure.md](project_structure.md)。

## 目录结构

```text
packages/protocol/       两边交换的数据（只有类型）
packages/core/           后端
  src/
    model/               模型适配器、流式解析、重试
    loop/                核心循环：调模型 → 执行工具 → 再调模型
    render/              把对话记录渲染成模型消息
    agent/               处理一次请求
    protocol/            请求校验
    server/              HTTP 处理函数、Node 适配
    log/                 日志与回放
  scripts/               try / chat / replay
packages/bridge/src/     前端：控件命名、操作记录、界面快照、报错采集、定位、引导、对话驱动
apps/playground/         演示应用 + 端到端测试
apps/evals/              评测场景
```

## 路线图

- [x] **换骨架**：协议、无状态接口、前端对话驱动、结构化感知。答疑可用，已在真实浏览器里端到端验证。
- [x] **单屏引导**：在页面上高亮控件并用气泡说明，用户做完一步自动到下一步；结果回到模型，由它确认或接着引导。
- [ ] **跨屏引导**：换页后接着引导，刷新后恢复，用户走偏时改道。
- [ ] **文档检索**：模型按需搜索和阅读你的产品文档。
- [ ] **自带问答窗**与语言包。

以后再做：按需截图（图表、画布）、预置的首次引导、接入 Skill、主动提示、脱敏。

不做：内置向量检索、原生客户端（Qt、WPF、安卓/iOS 原生等）的 bridge。
