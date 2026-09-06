<h1 align="center">Context Doctor</h1>

<p align="center">
  <strong>DSH 上下文注入审计插件：看清模型每个请求到底背着多少上下文，找出重复、冲突与浪费 token 的注入物。</strong>
</p>

<p align="center">
  <strong>全程只读</strong> ·
  <strong>token 成本逐项量化</strong> ·
  <strong>可执行裁剪建议</strong>
</p>

<p align="center">
  <a href="https://github.com/Zhenyu98/dsh-context-doctor/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/Zhenyu98/dsh-context-doctor?style=for-the-badge&color=eab308"></a>
  <a href="LICENSE"><img alt="License BSD-3-Clause" src="https://img.shields.io/badge/License-BSD%203--Clause-blue.svg?style=for-the-badge"></a>
  <a href="https://github.com/Zhenyu98/dsh-context-doctor/releases"><img alt="Version 0.7.2" src="https://img.shields.io/badge/Version-0.7.2-green.svg?style=for-the-badge"></a>
  <a href="https://github.com/deepseek-ai/awesome-deepseek-agent"><img alt="For DeepSeek Harness" src="https://img.shields.io/badge/For-DeepSeek%20Harness-8257D0.svg?style=for-the-badge"></a>
</p>

<p align="center">
  <a href="#why">为什么</a> ·
  <a href="#quick-start">快速安装</a> ·
  <a href="#agent-setup">Agent 安装</a> ·
  <a href="#它能做什么">功能</a> ·
  <a href="#使用">使用</a> ·
  <a href="#faq">FAQ</a> ·
  <a href="#license">License</a>
</p>

<p align="center">
  <sub>面板文案跟随 DSH 的语言设置（简体中文 / English），并沿用宿主的浅色 / 深色 / 跟随系统主题。<br>
  截图待更新至 v0.7 版式。</sub>
</p>

## Why

DSH 会话里，模型每个请求都自动携带一批注入物：层层叠加的 `AGENTS.md` 指令链、一百多个技能的目录摘要、几十个工具 schema、MCP 工具面。它们悄悄消耗输入 token，且经常出现跨文件重复段落、同名技能互相遮蔽、工具面膨胀——但平时没人量化，问题到上下文告警时才暴露。

| 之前 | 之后 |
|---|---|
| 只能靠上下文计量条猜个大概，说不清是谁在消耗 | 指令链 / 技能 catalog / 工具 schema / MCP 四项逐项给出 token 估算 |
| 重复指令、重复技能描述散落在各层文件里，无人察觉 | 自动检测跨文件完全相同的重复段落、描述完全相同的冗余技能 |
| 同名技能多来源并存时被静默遮蔽，模型用的是哪个要靠猜 | 报告冲突胜出者与被遮蔽者（rank shadow） |
| 看到告警只能手工翻文件找线索 | 模型可直接调用 `context_audit` 拿到分节报告与按严重度排序的裁剪建议 |

## Quick Start

> **宿主版本要求**：DSH `>= 0.1.2-rc.1`（已对 0.1.2-rc.1 验证）。0.1.2 重排了客户端模块表（`dsh-client-runtime` 换成 `dsh-client-store`），旧版宿主请固定 [`v0.6.1`](https://github.com/Zhenyu98/dsh-context-doctor/releases/tag/v0.6.1) —— 版本错配会让**整个 web shell** 起不来，不只是本插件（见 [#9](https://github.com/Zhenyu98/dsh-context-doctor/issues/9)）。`@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-tools` 是 peer 依赖，由宿主 profile 提供；插件不自带这两份运行时（自带会铸造第二个工具调度器，见 [#2](https://github.com/Zhenyu98/dsh-context-doctor/issues/2)）。

```sh
# 1. 安装（官方 bundle 插件机制；构建产物已入库，git 源安装无需构建）
dsh plugin --profile web add "github:Zhenyu98/dsh-context-doctor#main"

# 2. 验证合成树含该条目
dsh --profile web --dump-config | grep context-doctor

# 3. 重启 dsh web，在新会话里让模型调用
context_audit
```

预期成功信号：

```text
dsh --profile web --dump-config | grep context-doctor
# - insert:
#     - id: context-doctor
#       name: 'dsh-context-doctor'
```

重启后，在**已有会话**的发送按钮左侧出现 `Context Doctor` 控件，或模型调用 `context_audit` 返回分节报告，即安装成功。面板文案跟随 DSH 的语言设置，并沿用其浅色 / 深色 / 跟随系统主题；新会话尚未分配 `sessionId` 时不会显示会话级控件。

## Agent Setup

把下面这段发给 Codex、Claude Code、Cursor 或 DSH 里的任意 agent：

```text
请阅读 https://github.com/Zhenyu98/dsh-context-doctor/blob/main/agent-setup.md
并按照步骤帮我安装和配置 Context Doctor（DSH 上下文注入审计插件）。
目标：装好后我能在 dsh web 里看到 Context Doctor 面板，并能让模型调用 context_audit。
修改文件、使用凭据、发布或运行破坏性命令前，先给我看计划并征得同意。
```

完整安装、验证与排障见 [agent-setup.md](agent-setup.md)。

## 它能做什么

### 两种形态

1. **Web UI `Context Doctor` 面板**（已有会话的发送按钮左侧，与内置计量条并列；触发器是 30×30 的纯图标按钮，颜色即状态，名称在 tooltip 里）：顶部一条预算轨把 10k / 30k 两个阈值直接画成刻度——离警戒线还有多远是看得见的，不再是隐含规则；轨内按互不重叠的四项（指令链 / 技能目录 / 内置工具 schema / MCP 工具）着色分段。每项可展开到具体条目——指令链逐文件、技能按来源、工具按单个 schema、MCP 按服务器——直接回答「谁在占用」。面板文案跟随 DSH 的语言设置（中 / 英），正文沿用宿主 UI 字体、等宽只用于数字；点击面板外任意处或按 Esc 收起。面板自动跟随 DSH 的浅色、深色与系统主题，并会在窄视窗内滚动以保持完整可用。数据经 `GET /api/context-doctor/audit`（host 侧 60s 缓存）拉取。
2. **`context_audit` 模型工具**：完整审计报告（含 rank shadow 冲突与按严重度排序的建议），模型可自主调用并执行建议。

### 审计内容

| 注入物 | 审计内容 | 成本性质 |
|---|---|---|
| **指令链** | 从 git 根到当前工作目录每一层的 `AGENTS.md` / `CLAUDE.md`：文件数、token 估算、**跨文件完全相同的重复段落** | 每请求常驻 |
| **技能目录（catalog）** | `ctx.skills` 中所有技能的 `name + description`（模型每请求看到 `<available_skills>`）、按来源分组统计、**描述完全相同的冗余技能** | 每请求常驻 |
| **工具 schema** | 当前 agent 可见的全部工具（`ctx.tools.schemas`）：数量、schema token 估算、原生工具与 MCP 工具分组 | 每请求常驻 |
| **MCP 工具面** | 按服务器分组的 MCP 工具数与 schema token（`mcp__<server>__<tool>` 命名解析），识别工具面膨胀 | 每请求常驻 |
| **技能正文**（可选） | 前 N 个技能的正文总 token（按需加载，不常驻请求，用于对比"常驻 vs 按需"成本） | 按需加载 |

**冲突检测**：同名技能多来源并存时（如项目技能 shadow 掉 bundled 技能），报告哪个胜出、哪些被静默遮蔽。

## 使用

模型直接调用工具：

```
context_audit            # 审计当前会话工作目录
context_audit cwd=/path/to/project
context_audit includeSkillBodies=true maxSkillBodies=20
context_audit detail=developer  # 摘要 + 可定位的 context-audit receipt
```

输出 canonical JSON（`AuditReport`）：

```jsonc
{
  "tool": "context_audit",
  "version": 1,
  "cwd": "/path/to/project",
  "injected": {
    "instructions": { "files": [{ "path": "...", "bytes": 3421, "tokens": 812 }], "totalTokens": 812, "duplicateBlocks": [...] },
    "skills": { "catalogCount": 177, "catalogDescriptionTokens": 4150, "bySource": [...], "duplicateDescriptions": [...] },
    "tools": { "visibleCount": 42, "schemaTokens": 9800, "nativeCount": 38, "nativeTokens": 6100,
               "mcp": { "servers": [{ "server": "github", "tools": 12, "schemaTokens": 2400 }], "totalTools": 12, "totalTokens": 2400 } }
  },
  "conflicts": [{ "name": "skill-x", "winner": {"source": "project-dsh", ...}, "shadowed": [...] }],
  "suggestions": [{ "severity": "high", "text": "..." }]
}
```

Native 渲染为分节可读报告（指令链 / 技能 / 工具 / 冲突 / 建议），模型可直接照建议执行裁剪。

### 两级输出

- **默认摘要**：成本、冲突与按严重度排序的修复建议，适合每次诊断调用。
- **`detail=developer` 回执**：附加 `context-audit receipt`，逐项列出已加载的 `AGENTS.md` / `CLAUDE.md`（路径、字节、token、加载顺序与重复块短预览）、catalog 注入的 skills（名称、来源、provider、描述字节）、每个 tool schema 的序列化字节与签名、重复 MCP 签名、shadowed skill 关系和可执行修复建议。

`trimmed` 只有在 DSH 暴露上下文装配轨迹后才会给出条目；当前版本固定标记为 `unavailable`，避免将不可观测状态误报成已裁剪内容。回执不含完整 prompt 或技能正文，Agent 可依据路径和名称进行定点读取。

## 配置

```yaml
context-doctor:
  defaultCwd: /path/to/project   # 浏览器面板不带 cwd 参数时的默认审计目录（缺省为进程启动目录）
  cacheTtlMs: 60000              # 审计结果缓存时长（毫秒）
```

## 安全边界

- **只读**：只用 `ctx.fs` 的 read/stat/list 子集，不写不删；不执行任何审计对象。
- **大小上限**：单文件 > 256 KB 跳过，防止审计器自身被拖垮。
- **不输出正文**：报告只含路径、统计与重复段落片段，不含完整文件内容；技能正文仅统计 token 总量。
- **token 为启发式估算**（ASCII ≈ 4 字符/token，中文 ≈ 1.5 字符/token），用于相对比较，精确值以模型 tokenizer 为准。

## FAQ

**装了之后控件没出现？**

重启 `dsh web` 后进入已有会话的 composer；新会话在分配 `sessionId` 前不会显示会话级控件。仍没有则先确认 `dsh --profile web --dump-config` 含 context-doctor 条目，且浏览器半区构建产物存在（改过源码必须重新 `./scripts/build.sh`）。

> v0.5.0 及更早版本把控件注册到 `conversation.input.context`——那个插槽任何已发布的 DSH 都没有，控件因此被静默丢弃（[#4](https://github.com/Zhenyu98/dsh-context-doctor/issues/4)）。v0.5.2 起改用原生插槽 `conversation.input.right`，无需给 DSH 打补丁。

**没有 Web 界面（headless / CLI）能用吗？**

能。`context_audit` 工具不依赖 Web：插件在无 `httpServer` 服务的环境（如 headless profile）下自动跳过路由注册，工具照常可用。已验证 `dsh --profile headless` 下可直接调用。

**审计结果和计量条对不上？**

计量条是模型侧的实际 token；本插件的 token 是启发式估算（ASCII ≈ 4 字符/token，中文 ≈ 1.5 字符/token），用于相对比较与优化优先级排序，精确值以模型 tokenizer 为准。

**插件会修改我的文件吗？**

不会。审计路径全程只读：只用 `ctx.fs` 的 read/stat/list 子集，不写、不删、不执行任何审计对象。

**MCP 工具怎么分组统计的？**

按 `mcp__<server>__<tool>` 命名解析出服务器名，按服务器汇总工具数与 schema token，用于识别工具面膨胀。

**私密文件会被读进报告吗？**

报告只含路径、统计与重复段落片段，不含完整文件内容；技能正文仅统计 token 总量，不输出正文。

## 开发

```sh
./scripts/setup-dsh-deps.mjs   # 定位本机 DSH checkout 并链接依赖（首次）
node --test 'tests/*.test.ts'  # node --test（Node ≥ 22.19，原生 TS 支持，零测试依赖）
./scripts/build.sh             # setup + tsc（lib/types）+ tsdown（lib/index.js + lib/client.js）
```

测试 39 个用例：发布产物纯度守卫（宿主运行时必须外置，见 [#2](https://github.com/Zhenyu98/dsh-context-doctor/issues/2)）、token 估算、重复块/描述检测、rank shadow、MCP 分组、指令链端到端（真实临时文件系统 + fake FileSystem）、插件入口与完整 execute 报告链路、会话工作目录路由、HTTP 路由（方法检查 + 真实审计响应 + 缓存上限淘汰）、headless 无 httpServer 环境。

## 已知限制

- 控件与 DSH 内置的上下文计量条并列显示，不替代它——`conversation.input.right` 是 `kind: 'list'` 插槽，落座不挤占任何既有控件。
- 指令链重复检测只做"完全相同的段落块"，不做语义相似度；跨文件引用同一事实的不同表述暂不识别。
- MCP 工具 schema 按 `name + description` 估算，未计入 JSON Schema 参数细节。
- 技能正文统计默认关闭（加载正文有成本），catalog 摘要成本始终统计。

## Star History

<a href="https://star-history.com/#Zhenyu98/dsh-context-doctor&Date">
  <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Zhenyu98/dsh-context-doctor&amp;type=Date" width="70%">
</a>

## Acknowledgements

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — 插件运行平台与官方 bundle 插件机制
- [plugin-registry](https://github.com/dsh-external/plugin-registry) — 插件开发规范与 make-dsh-plugin 引导

## Contributing

Issues 与 pull requests 都欢迎。请保持报告具体、附上复现步骤，并在日志与截图中避免包含密钥。

## License

本项目以 BSD-3-Clause 协议发布，见 [LICENSE](LICENSE)。
