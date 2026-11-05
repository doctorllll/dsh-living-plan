# dsh-living-plan

给 DeepSeek Harness 会话一份**活计划**：每个会话一份 Markdown，模型在动手前写、工作中改；每次保存成为新版本；系统提示每一步都带上当前版本，所以压缩、重开、用户插话后都不会丢。

它补的是官方 `/plan`（一次性评审）和 `goal`（一句目标）之间的空档：**长任务的“现在在哪、下一步做什么”**。

## 它做什么

- **固定位置**：`$DSH_HOME/living-plan/<session-id>/plan.md`（默认 `~/.dsh/living-plan/...`），按会话隔离，不污染工作区仓库。
- **每次请求都注入**：插件注册一个 system prompt section，每个模型步骤现读计划文件；计划在上下文里，不靠摘要活着。
- **版本**：每次 `plan_write` 或用户直接改文件，版本 +1，旧版留在 `history/vNNNN.md`，可选 `history/index.jsonl` 记变更说明。
- **用户可改**：直接编辑 `plan.md` 是支持路径，不是篡改。下一次请求会把它当作新版本，并把新版内容注入给模型。
- **写前校验**：`plan_write` 只接受“模型已经看过当前版本”的写入；如果文件在两步之间被改过，写入被拒，提示先 `plan_read`。这是防覆盖用户改动的闸门。
- **子代理默认不建计划**：`includeSubagents: false`，主会话的计划仍是唯一工作台；需要时可打开。

## 装法

先完全退出 DeepSeek Harness 桌面 App。desktop profile 只认 App 自带 CLI，PATH 里的 npm 全局 `dsh` 会报 `profile "desktop" is managed exclusively by the Electron application`。

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add /Users/2_dogg/code/dsh-living-plan
```

重启 App。插件随 profile 加载，对所有新会话生效。

卸载：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop remove dsh-living-plan
```

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖（默认值见 `cordis.patch.yml`）：

```yaml
- id: living-plan
  config:
    includeSubagents: false   # 子代理会话也各自建计划
    maxPlanBytes: 24576       # 计划上限（字节）；超了 plan_write 拒绝，提示只留接手续作所需
    historyLimit: 50          # 保留最近多少版
    sectionOrder: 950         # 提示词位置；影响缓存前缀
    home: null                # 默认 $DSH_HOME 或 ~/.dsh
```

## 模型看到的工具

| 工具 | 作用 |
|---|---|
| `plan_read` | 读当前计划，并标记这一版已看过 |
| `plan_write` | 整份替换计划，生成下一版；参数 `markdown`，可选 `note` |

提示词里会写清：什么时候写、什么时候改、怎么写（只写“现在在哪”，完成项删过程留结果）、写前先读。

## 面板 UI

右栏 Guides 里有「计划」卡片，点开是当前会话的计划面板：

- 当前版本、更新时间、`agent 保存` / `用户修改`、文件路径；
- Markdown 渲染（标题、待办勾选框、代码块、引用、表格），每 5 秒自动刷新；
- 历史版本 chips，点任意一版只读查看，顶部有「回到当前」；
- 「复制路径」「刷新」。

面板通过本机路由 `GET /api/living-plan?sessionId=...` 读同一个 store，只读，不会替模型标记“已看过”。历史版本用 `&version=N`。

## 已验证（2026-11-05，DSH 0.2.1-rc.5）

Host / headless：

- 新会话：模型调 `plan_write`，生成 v1；文件、`meta.json`、`history/v0001.md` 都对。
- 同会话续跑（`--session-id`）：调 `plan_write` 生成 v2。
- 用户直接改 `plan.md`：下一次请求把它记为 v3（`updatedBy: user`），模型逐字复述出了新增的补充行。
- `plan_read`：返回 v3、139 字节。

Web 面板（一次性 `web` profile，ego-lite 实测）：

- 右栏 Guides 出现「计划」，点开显示 v2 计划、勾选框和路径；
- 再写一版后历史 chips 出现 v2/v1，点 v1 显示黄色「正在看历史版本 v1」横幅，内容确实没有 v2 的进展行；
- 直接改 `plan.md` 追加一行，5 秒轮询后变成 v3、`用户修改`、历史 3 版，新行出现在面板里。

PTC / 桌面：

- `desktop` profile 安装 0.2.0，App 重启后新会话系统提示出现 living plan section；
- 一次性 web profile 强制 `default: ptc`，新建会话让模型调 `plan_write`：v1 成功、554 字节，模型在 `run_code` 里调用工具；同一会话右栏「计划」显示 PTC 计划；
- 安装前就已存在的会话可能缓存旧 `tools:sdk` 声明（新工具不在声明里但 `tools.plan_*` 实际可调用）；开新会话即可拿到完整 SDK 声明。

核心单测 11 项全过（含历史列表、按版本读取、客户端 bundle 结构）。

## 已知边界

- **面板是只读的**：改计划仍走 agent 的 `plan_write`，或直接编辑 `plan.md`；面板不做行内编辑和 diff（下一版可加）。
- **不是工作区文件**：计划存在 `$DSH_HOME` 下，避免污染 git 仓；要在仓库里看，路径在提示词里。
- **整份替换**：没有局部 patch，模型每次提交完整 Markdown；14–24KB 量级够用。
- **不替代 `/plan`**：评审仍走官方 `exit_plan_mode`；评审通过后让模型把同一份计划 `plan_write` 下来即可。
- **API 风险**：依赖 `agent/created`、`agent.ctx.systemPrompt.section`、`ctx.tools.register`；DSH rc 升级后要回归。
