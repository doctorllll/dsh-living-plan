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

先完全退出 DeepSeek Harness 桌面 App，再：

```sh
dsh plugin --profile desktop add /Users/2_dogg/code/dsh-living-plan
```

重启 App。插件随 profile 加载，对所有新会话生效。

卸载：

```sh
dsh plugin --profile desktop remove dsh-living-plan
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

## 已验证（2026-11-05，DSH 0.2.1-rc.5，headless 一次性会话）

- 新会话：模型调 `plan_write`，生成 v1；文件、`meta.json`、`history/v0001.md` 都对。
- 同会话续跑（`--session-id`）：调 `plan_write` 生成 v2。
- 用户直接改 `plan.md`：下一次请求把它记为 v3（`updatedBy: user`），模型逐字复述出了新增的补充行。
- `plan_read`：返回 v3、139 字节。
- 核心单测 9 项全过（空计划、超限、外部改动成版、陈旧写入冲突、删除即清空、历史窗口、按会话隔离）。

## 已知边界

- **没有面板 UI**：计划是文件，用户要打开路径看；下一步可加右栏面板/版本 diff。
- **不是工作区文件**：计划存在 `$DSH_HOME` 下，避免污染 git 仓；要在仓库里看，路径在提示词里。
- **整份替换**：没有局部 patch，模型每次提交完整 Markdown；14–24KB 量级够用。
- **不替代 `/plan`**：评审仍走官方 `exit_plan_mode`；评审通过后让模型把同一份计划 `plan_write` 下来即可。
- **API 风险**：依赖 `agent/created`、`agent.ctx.systemPrompt.section`、`ctx.tools.register`；DSH rc 升级后要回归。
