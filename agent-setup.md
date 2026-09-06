# Agent Setup — Context Doctor

DSH 上下文注入审计插件：安装后，模型可调用 `context_audit` 工具查看上下文注入物的 token 成本与裁剪建议，Web UI 的 composer 工具行出现 Context Doctor 控件。

## Copy-Paste Prompt

```text
请阅读 https://github.com/Zhenyu98/dsh-context-doctor/blob/main/agent-setup.md
并按照步骤帮我安装和配置 Context Doctor（DSH 上下文注入审计插件）。
目标：装好后我能在 dsh web 里看到 Context Doctor 面板，并能让模型调用 context_audit。
修改文件、使用凭据、发布或运行破坏性命令前，先给我看计划并征得同意。
默认只运行非破坏性检查，完成后报告：改动了哪些文件、运行了哪些命令、验证结果。
```

## Prerequisites

- 已安装 DeepSeek Harness（`dsh` 在 PATH 中，≥ snapshot0811 / 0.0.1-rc.1）
- Node.js ≥ 22.19（仅开发/构建需要；git 源安装已含构建产物，无需本机构建）

## Setup Steps

1. **安装**（官方 bundle 插件机制，构建产物已入库，无需构建）：

   ```sh
   dsh plugin --profile web add "github:Zhenyu98/dsh-context-doctor#main"
   ```

2. **验证合成树**：

   ```sh
   dsh --profile web --dump-config | grep context-doctor
   ```

3. **重启 dsh web**，在新会话中让模型调用 `context_audit`，或点开 composer 工具行里的 Context Doctor 控件。

## Success Signal

- `dsh --profile web --dump-config | grep context-doctor` 输出含 `- id: context-doctor` 与 `name: 'dsh-context-doctor'` 的 insert 条目
- 新会话中 `context_audit` 返回分节报告（指令链 / 技能 / 工具 / 冲突 / 建议）
- composer 发送按钮左侧出现 Context Doctor 图标按钮（图标颜色按注入量分级：绿 / 黄 / 红）
- headless / CLI 环境（无 Web）同样可用：`dsh --profile headless --patch <含插件的 patch> "调用 context_audit"` 可得到报告

## Safety Rules

- 插件本身全程只读，不修改任何被审计文件；报告不含完整文件内容
- 不要读取或打印密钥
- 未经明确同意，不要发布、推送、删除或部署任何内容
- 安装命令只操作 `$DSH_HOME/profiles/web` 下的 profile 配置，不动其他目录

## Common Fixes

**`dsh plugin` 报 pnpm 找不到**：确认 pnpm 在 PATH；安装是显式包管理操作，需要 pnpm。

**控件没出现**：确认已重启 `dsh web`（浏览器半区产物在启动时校验）；若改过插件源码，需重新 `./scripts/build.sh` 再重启。

**报告 token 数与计量条不一致**：token 为启发式估算（ASCII ≈ 4 字符/token，中文 ≈ 1.5 字符/token），用于相对比较，精确值以模型 tokenizer 为准。
