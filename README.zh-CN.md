# DocCue

[![CI](https://github.com/muyuzhong/DocCue/actions/workflows/ci.yml/badge.svg)](https://github.com/muyuzhong/DocCue/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> Turn static docs into context-aware in-app cues.

[English](README.md) · 简体中文 · [API 参考（英文）](docs/api.md)

复杂的应用上手慢，文档又放在官网上。DocCue 是**新手引导的 agent 版**：嵌在你的 Web 应用里，用户问"怎么做"或"为什么不行"，它结合用户刚才在界面上做了什么来回答，并在页面上一步步指给用户看。

- **只指不做**：agent 不操控应用，不替用户点击和填写。
- **只在被问到时出现**：不主动打扰。
- **接入简单**：前端加一个包，后端挂一个接口。登录鉴权、数据库、部署这些你的系统里本来就有的能力，DocCue 不重复造。

> **当前状态**：0.1.0，尚未发布到 npm。答疑、可视引导（包括跨页面、经过弹窗、整页刷新后继续）、产品文档检索和自带问答窗都已可用，并在真实浏览器 + 真实模型上端到端验证过。除了演示应用，还在两个不是为它写的开源应用上试过：[Grafana](https://github.com/grafana/grafana) 和 [Homebox](https://github.com/sysadminsmedia/homebox)，没有改它们的代码。1.0 之前接口还可能变。详见[路线图](#路线图)。

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

要去别的页面才能做的事也一样：在仪表盘说"我想新建一个 MySQL 数据源"，它先指向导航里的「新建数据源」，换页后再逐个指出表单里要填的内容，保存后确认新数据源出现在列表里。

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

playground 是一个模拟的「数据平台」，右下角是 bridge 自带的问答窗。试试：进入「新建数据源」，主机地址填 `http://127.0.0.1:5432`，点「测试连接」，然后点右下角的按钮问「为什么连不上？」，跟着页面上的气泡改。右侧的「agent 看到了什么」是调试栏（接入时没有），实时显示 bridge 记下的操作，以及模型最近一次看到的现场信息。

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
| `pnpm journeys [名字片段]` | 多步评测：本机 Chrome 里脚本扮演用户，跟着引导操作，检查有没有达到目标 |
| `pnpm --filter @doccue/hosts serve <grafana\|homebox>` | 真实应用 + 注入代理加上的 DocCue，手动试（第一次会下载应用） |
| `pnpm --filter @doccue/hosts ask <应用> [场景]` | 在真实应用上用真实模型跑场景；`DOCS=off` 不给文档，用来对比 |
| `pnpm try [--tool] "问题"` | 跑单轮；`--tool` 挂一个查时间的演示工具，测多步循环 |
| `pnpm chat` | 多轮对话，日志写到 `packages/core/.logs/` |
| `pnpm replay <日志> [编号]` | 列出日志里的模型调用；带编号则把那次调用原样重发，对比前后两次回答 |
| `pnpm test:unit` | 不调模型的离线单元测试（`packages/*`，不需要 API key） |
| `pnpm test` | 全量测试。不用假模型：涉及模型的测试调 `.env` 里的真实模型，前端在本机 Chrome 里跑 playground |
| `pnpm typecheck` / `pnpm build` | 类型检查 / 构建 |

每次推送，CI 会跑构建、类型检查、离线单元测试，以及用打包产物验证 `examples/basic`；调真实模型的测试要手动触发（见 [.github/workflows](.github/workflows)）。参与贡献请见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 接入你的应用

```bash
npm install @doccue/core @doccue/bridge
```

**后端**：把处理函数挂到你的服务上。

```ts
import { createHandler, createModelFromEnv, withRetry } from '@doccue/core';
import { markdownDocs, toNodeHandler } from '@doccue/core/node';

const handler = createHandler({
  model: withRetry(createModelFromEnv(process.env)),
  instructions: '你是「数据平台」的应用内助手，帮用户上手和解决使用中的问题。',
  docs: await markdownDocs('./docs'),   // 你的产品文档（Markdown），可选
  basePath: '/doccue',
  user: (request) => sessionOf(request)?.attributes,   // 用户属性从你自己的会话取，可选
});

// Express / Connect / node:http；Fetch 风格的框架（Hono、Next.js 路由等）直接用 handler
app.use('/doccue', toNodeHandler(handler));
```

**前端**：两行接入。

```ts
import { createBridge } from '@doccue/bridge';

const cue = createBridge({ endpoint: '/doccue' });   // 从这一行开始记录用户操作
await cue.mount();                                   // 右下角的问答窗
```

问答窗在 Shadow DOM 里，不受页面样式影响；位置和主色用 CSS 变量调（`--doccue-right`、`--doccue-bottom`、`--doccue-accent`），深色主题用 `createBridge({ theme: 'dark' })`（或 `'auto'` 跟随系统），手机上打开时占满屏幕。文案跟随页面语言（现在有中文和英文），可以用 `createBridge({ messages: { title: '数据平台助手' } })` 改任何一条。

想用自己的问答框也可以，不调 `mount()`，在这几个接口上搭：

```ts
cue.on('text', (event) => console.log(event.delta));  // 流式回答
cue.on('end', (event) => console.log(event.reason));
cue.on('guide_end', (event) => console.log(event.outcome));   // 页面上的一段引导结束

// 用户在你的问答框里提问时：连同记录下的操作和当前界面一起发给 agent
await cue.ask('为什么连不上？');   // 回答需要指给用户看时，bridge 会自己在页面上引导
cue.stop();     // 停止当前回答，关掉页面上的引导
cue.reset();    // 开始新对话
```

请求体（问题、界面、对话记录、bridge 的 `user`）全部来自浏览器，可信程度和用户自己打的字一样。角色、套餐这类要作数的属性用 `createHandler` 的 `user` 从服务端会话里取，它会覆盖浏览器发来的那份。

自己做的问答框要加 `data-cue-ignore`，免得用户在里面打字也被当成操作记下来（自带问答窗已经加了）。bridge 平时只在浏览器本地记录，提问时才上传；密码只记"填写过"，不记内容。

接口是开放的，鉴权和限流由你在自己的路由和中间件里处理；如果接口需要认证请求头（如 Bearer token、CSRF token）或跨域 Cookie，可以给 `createBridge` 传 `headers`（支持静态对象或异步函数）、`credentials: 'include'` 或自定义 `fetch`。后端不保存对话：对话记录在浏览器的 sessionStorage 里，每个标签页一份。整页刷新或跳转后，新页面上的 bridge 会接着之前的引导和回答，所以多页应用也能用，只要每个页面都调用 `createBridge`。

完整的参数说明、自定义后端工具、自定义文档/模型适配器、HTML 属性（`data-cue-id`、`data-cue-error`）、CSS 变量以及当前边界（宿主内部 Shadow DOM、`<iframe>`、`<canvas>` 图表）见 [API 参考](docs/api.md)，安全信任边界与漏洞上报见 [SECURITY.md](SECURITY.md)。

## 接入示例

- [`examples/basic`](examples/basic)：Node 自带的 `http` 服务加一个用 import map 的纯 HTML 页面，不需要构建。
- [`examples/nextjs`](examples/nextjs)：Next.js App Router 应用，一个路由处理器加一个客户端组件。

两个示例是同一个小小的成员页面：邀请工作区不允许的域名的邮箱会失败，文档里写了原因。问助手，它会带你先允许这个域名，再重新发送邀请。

## 模型接入

运行时零依赖，直接用原生 `fetch` 对接接口：

| 适配器 | 适用 | 说明 |
| :--- | :--- | :--- |
| `createAnthropic` | Claude 模型（官方接口或中转） | API 版本 `2026-10-21`；思考块原样回传；官方地址下默认开启自动提示词缓存、工具参数流式传输，以及拒答自动换模型（限 claude-opus-5-5 等支持的模型），走中转时默认关闭 |
| `createOpenAI` | OpenAI，以及所有 OpenAI 兼容接口（Ollama、vLLM、LM Studio、各类网关） | 相邻的用户消息会合并，兼容要求角色交替的本地模型 |

两者都支持：60 秒收不到任何数据就断开（心跳包也算数据）、`withRetry` 对限流和服务端错误自动重试（只在还没输出时重试）、通过 `withModelLog` 记录每次调用的完整请求和耗时。`createModelFromEnv` 从环境变量创建适配器，变量见 [.env.example](.env.example)。

**模型选型与成本**：`createModelFromEnv` 在 Anthropic 下默认使用 `claude-opus-5-5`，对应用内帮助浮窗而言成本和延迟偏高。生产环境推荐优先试轻量快速的模型（Grafana 与 Homebox 的完整验证均使用 `claude-haiku-5-5`）；开启提示词缓存（`DOCCUE_PROMPT_CACHE=on`，Anthropic 官方地址默认开启）后，多轮问答和多步引导中的系统提示词、文档和历史对话都能持续命中缓存。也可以实现 `ModelAdapter` 接入任意其他模型服务（见 [docs/api.md](docs/api.md#custom-modeladapter)）。

## 架构

agent 在后端，但它要用的东西（界面、用户的操作、以后的可视引导）大多在浏览器里。所以后端只做一件事：收到完整的对话记录，调模型，流式返回。

| 前端 `@doccue/bridge` | 后端 `@doccue/core` |
| :--- | :--- |
| 感知：记录操作及其后果，生成界面快照 | 渲染：把对话记录转成给模型的消息 |
| 引导：聚光灯、气泡、步骤推进 | 循环：调模型，执行后端工具，遇到 `guide` 就交给前端 |
| 问答窗：自带的对话界面，按需加载 | |
| 对话：保存记录、发请求、执行引导并回传结果 | 文档：检索和阅读产品文档 |
| | 模型适配、日志与回放 |

两边交换的数据定义在 `@doccue/protocol`。完整设计见 [architecture_design.md](architecture_design.md)，代码结构和进度见 [project_structure.md](project_structure.md)。

## 目录结构

```text
packages/protocol/       两边交换的数据（只有类型）
packages/core/           后端
  src/
    model/               模型适配器、流式解析、重试
    loop/                核心循环：调模型 → 执行工具 → 再调模型
    render/              把对话记录渲染成模型消息
    docs/                产品文档：切分、检索、search_docs / read_doc
    agent/               处理一次请求
    protocol/            请求校验
    server/              HTTP 处理函数、Node 适配
    log/                 日志与回放
  scripts/               try / chat / replay
packages/bridge/src/     前端：控件命名、操作记录、界面快照、报错采集、定位、引导、对话驱动、自带问答窗
apps/playground/         演示应用 + 端到端测试
apps/evals/              评测场景
apps/hosts/              不是为 DocCue 写的真实应用（Grafana、Homebox），经注入代理接入
examples/                用已发布的包接入的示例应用
```

## 路线图

- [x] **换骨架**：协议、无状态接口、前端对话驱动、结构化感知。答疑可用，已在真实浏览器里端到端验证。
- [x] **单屏引导**：在页面上高亮控件并用气泡说明，用户做完一步自动到下一步；结果回到模型，由它确认或接着引导。
- [x] **跨屏引导**：换页、开弹窗后接着引导，整页刷新后恢复，用户走偏或提前做了后面的步骤时跟上。
- [x] **文档检索**：模型按需搜索和阅读你的产品文档；文档小时整份放进提示词。也可以接你自己的搜索服务。
- [x] **自带问答窗**与语言包：一行挂上；引导时收成小条；中英文，文案可覆盖。
- [x] **真实应用**：在 Grafana 和 Homebox 上试过，补上了它们暴露出的缺口（自绘下拉框和日期选择器、纯图标按钮、弹出列表、label 关联到别处）。
- [ ] **第一个版本**发布到 npm。

以后再做：按需截图（图表、画布）、预置的首次引导、接入 Skill、主动提示、脱敏。

不做：内置向量检索、原生客户端（Qt、WPF、安卓/iOS 原生等）的 bridge。
## 参与贡献与变更日志

- 欢迎提 Issue 和 PR，开发环境、离线测试（`pnpm test:unit`）与提交规范见 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 版本变更见 [CHANGELOG.md](CHANGELOG.md)，安全漏洞上报见 [SECURITY.md](SECURITY.md)。

## 许可证

[MIT](LICENSE)
