# harness-helper

以 **grill 拷问**的方式，引导你在项目中部署一套 agent harness。

与 `harness-creator`（脚本驱动的脚手架/审计/基准）不同，harness-helper 是**对话引导式**的：先扫描你的项目，再像“反复拷问”一样按五子系统逐个问清楚、给推荐答案、形成决策，最后生成产物并自检。

触发词：`/harness-helper`

## 流程

```
扫描 (scan.mjs)
  → [可选] 接入 graphify 等代码检索增强
  → grill 逐子系统拷问（指令/状态/验证/范围/生命周期）
  → 同步写 <target>/.harness-helper/decisions.{md,json}
  → 摘要拍板（用户确认）
  → 生成 (generate.mjs) 5 件产物
  → 自检 (validate.mjs) 五子系统结构分
```

## 脚本

全部仅用 Node 内置模块，拷进任何仓库即可运行。

```bash
node scripts/scan.mjs     --target /path/to/project   # 静态扫描，输出 JSON 事实
node scripts/generate.mjs --target /path/to/project   # 读 decisions.json 生成产物
node scripts/validate.mjs --target /path/to/project   # 五子系统结构打分
```

## 产物

- `AGENTS.md` 或 `CLAUDE.md`
- `feature_list.json`（功能尽量来自真实拷问）
- `progress.md`
- `session-handoff.md`
- `init.sh`

已存在的同名文件**默认不覆盖**，新内容写成 `<name>.proposed` 供你 diff 合并；确认覆盖时加 `--force`。

## scratchpad

grill 过程的决策暂存在**目标项目**的 `.harness-helper/`：
- `decisions.md` —— 人读的拷问 Q&A 回溯
- `decisions.json` —— 机读的结构化决策（generate.mjs 读取，结构见 `templates/decisions.schema.json`）

建议把 `.harness-helper/` 加进项目 `.gitignore`（本 skill 不替你改 .gitignore）。

## 五子系统

部署的思想来自《Learn Harness Engineering》12 讲，压缩为五个可操作子系统，详见 `references/five-subsystems-zh.md`：

1. 指令 (Instructions) — lecture 02/04
2. 状态 (State) — lecture 08
3. 验证 (Verification) — lecture 09/10
4. 范围 (Scope) — lecture 07/08
5. 生命周期 (Lifecycle) — lecture 05/06/12

## 边界

只做 harness 部署引导，不做选模型、单纯调 prompt、应用架构。项目相关的事实留在目标仓库里。

## License

MIT
