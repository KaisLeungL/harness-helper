---
name: harness-helper
description: >-
  以 grill 拷问的方式，引导用户在项目中部署 harness（AGENTS.md / feature_list.json /
  init.sh / progress.md / session-handoff.md）。先静态扫描项目，再按五子系统逐个拷问、
  形成决策、生成产物并自检打分。触发词 /harness-helper。
license: MIT
---

# Harness Helper

引导用户在**当前项目**里部署一套可靠的 agent harness。流程：**静态扫描 → grill 逐子系统拷问 → 摘要拍板 → 生成产物 → 结构自检**。

全程用**中文**。grill 风格：一次只问一个问题，每题给出推荐答案；能查代码就先查代码，别问用户能自己看出来的东西。

适用：让一个仓库更容易被 coding agent 启动、守范围、验证工作、跨会话续上。
不适用：选模型、单纯调 prompt、聊天 UI 设计、通用应用架构。

底层五子系统的 WHY 见 [references/five-subsystems-zh.md](references/five-subsystems-zh.md)，grill 时按需引用。

---

## 流程

### 第 0 步：确认目标项目

确认要部署 harness 的项目根目录（默认当前工作目录）。后续 `<target>` 都指它。

### 第 1 步：静态扫描

跑扫描脚本，把项目事实读进上下文：

```bash
node <skill>/scripts/scan.mjs --target <target>
```

输出 JSON：技术栈、包管理器、包脚本、推荐验证命令、git 状态、以及**五子系统在位情况**（`present` / `partial` / `missing`）。这是 grill“针对性”的依据。

### 第 1.5 步（可选）：接入代码检索增强

扫描是**纯静态**的。如果目标项目装了图谱检索类 skill（如 `graphify`）或其他代码检索引擎，**先调用它**获得对代码库的更深理解，再把结果并入 grill 的上下文，让拷问更贴合项目实际。没有就跳过，直接用 scan.mjs 的结果。

### 第 2 步：grill 逐子系统拷问

按固定顺序走五子系统，**每个子系统都过一遍**，但按 scan 结果调节问法：

| scan 标记 | 怎么问 |
|---|---|
| `missing` | 深入拷问：先讲清这个子系统的 WHY（引 references），再逐项问出决策 |
| `partial` | 针对缺口问：指出薄弱点（如“有 AGENTS.md 但没写完成定义”），只补缺的 |
| `present` | 一句话确认：“检测到你已有 X，保留并增补 / 还是重构？” 不重复盘问 |

顺序与要问出的内容：

1. **指令 (Instructions)** — 用 AGENTS.md 还是 CLAUDE.md；项目用途一句话；除默认启动步骤外还要做什么。
2. **状态 (State)** — 见第 4 步 Scope 一并问出 features（状态与范围共用 feature list）。先确认是否需要 progress.md（默认要）。**再问两个布局开关**：
   - **协作模式**（`collaboration.mode`）：单人项目 `solo`（默认）；多人协作 `team` —— `progress.md` / `session-handoff.md` 改成 `## @<git user.name>` 分节 + `merge=union` 追加式合并（多人同时追加各自节点永不冲突），`feature_list.json` 加 `owner` 字段（一个功能只由一人维护其条目）。**怎么判断**：scan 的 `gitState` 显示多作者、或用户提到团队/协作，就推荐 `team`。
   - **状态布局**（`state.layout`）：`root`（默认，状态文件放根目录）；`versioned`（放 `.harness/versions/<版本>/`，按版本维度组织）。**怎么判断**：项目有明确发版节奏（版本号写在某个文件里）就推荐 `versioned`，并问出**版本来源命令**（`state.versionSource.command`：一条打印版本号到 stdout 的 shell，如 `cat VERSION`、`node -p "require('./package.json').version"`；generate.mjs 与 init.sh 共用它）。
3. **验证 (Verification)** — 装依赖 / 类型检查 / lint / 测试 / 构建 / 端到端各用什么命令。scan 已给推荐命令，确认或修正。
4. **范围 (Scope)** — 这个项目接下来要做哪 3-5 件具体功能？依赖关系？每件“完成”的判定标准？是否强制一次一个功能？有无额外范围红线。**这一步问出的功能直接成为 feature_list 的真实条目**；实在问不出来才退回占位模板。
5. **生命周期 (Lifecycle)** — 是否需要 session-handoff.md（多会话/大任务建议要）；会话结束流程要补什么。

拷问规则：
- 一次一个问题，每题给**推荐答案**。
- 能从 scan 结果或代码里看出来的，不要问。
- 走完一个子系统就同步更新 scratchpad（第 3 步），不要攒到最后。

### 第 3 步：同步写 scratchpad（双文件）

scratchpad 写在**目标项目**的 `<target>/.harness-helper/` 下，供本轮会话回溯，**不进版本库**（提醒用户可自行把 `.harness-helper/` 加进 `.gitignore`，但本 skill 不替用户改 .gitignore）。

每问完一个子系统，同步维护两份：

- `<target>/.harness-helper/decisions.md` —— **人读**：把这一轮的拷问 Q&A、推荐答案、用户最终选择记成可回溯的对话纪要。
- `<target>/.harness-helper/decisions.json` —— **机读**：结构化决策，供 generate.mjs 读取。结构见 [templates/decisions.schema.json](templates/decisions.schema.json)。

decisions.json 形如：

```json
{
  "instructions":  { "agentFile": "AGENTS.md", "purpose": "...", "startupSteps": ["..."] },
  "state":         {
    "layout": "root",
    "versionSource": { "command": "cat VERSION", "label": "VERSION 文件" },
    "features": [{ "id": "feat-001", "name": "...", "description": "...", "owner": "...", "dependencies": [], "status": "not-started" }]
  },
  "verification":  { "commands": ["npm install", "npm run check", "npm test"] },
  "scope":         { "oneFeatureAtATime": true, "extraRules": ["..."], "doneCriteria": ["..."] },
  "lifecycle":     { "useHandoff": true, "endOfSessionSteps": ["..."] },
  "collaboration": { "mode": "solo" }
}
```

- `state.layout`：`root`（默认）或 `versioned`。选 `versioned` 时必须给 `state.versionSource.command`。
- `state.features[].owner`：仅 `collaboration.mode=team` 时有意义。
- `collaboration.mode`：`solo`（默认）或 `team`。`team` 触发 `## @author` 分节 + `merge=union` 合并。

### 第 4 步：摘要拍板

五段问完后，把**五子系统的决策摘要**呈现给用户（不是直接生成文件），让用户确认或修改。用户点头后才进入生成。

### 第 5 步：生成产物

```bash
node <skill>/scripts/generate.mjs --target <target>
```

读 `<target>/.harness-helper/decisions.json`，生成中文产物：
`AGENTS.md`（或 CLAUDE.md）、`feature_list.json`、`progress.md`、`session-handoff.md`、`init.sh`。

布局相关的额外产物：
- `state.layout=versioned`：状态文件写进 `.harness/versions/<版本>/`，并在 `.harness/templates/` 生成初始化模板（`init.sh` 在版本目录缺失时据此创建新版本）。
- `collaboration.mode=team`：`progress.md` / `session-handoff.md` 用 `## @author` 分节模板；幂等地把 `merge=union` 规则并入 `<target>/.gitattributes`（已有则只追加缺失行）。

**写盘安全**：同名文件已存在时**默认不覆盖**，新内容写成 `<name>.proposed`。生成后提示用户对存在 `.proposed` 的文件做 `diff` 后手动合并。确认要覆盖时才加 `--force`。`.gitattributes` 是幂等并入，不会覆盖既有内容。

### 第 6 步：结构自检

```bash
node <skill>/scripts/validate.mjs --target <target>
```

给产出的 harness 打五子系统结构分（总分 + 瓶颈子系统）。**说清楚这是结构分**——只衡量 harness 是否齐备自洽，真实效果仍需 before/after agent 会话验证。

---

## 设计规则

- 根指令文件要短：放路由和不可变约束，不写整本手册（lecture 04）。
- 项目事实放进项目文档，不要塞进 skill。
- 验证命令必须显式、可运行；要求有完成证据才算完成（lecture 09/10）。
- 默认一次一个功能，除非 harness 有显式的多 agent 归属边界（lecture 07/08）。
- 优先用文件持久化状态，别依赖对话历史（lecture 03/12）。
- 绝不在脚本里藏破坏性行为；覆盖已有文件必须经用户明确同意。
- 团队协作的状态文件（progress/handoff）用 `merge=union` + `## @author` 分节，让多人追加永不冲突；但 union 只对**追加式**安全，必须配“只追加不改写”的纪律。共享清单（feature_list）走正常合并，靠“一个条目一个 owner”降冲突。
- 状态文件位置（root vs versioned）和协作模式（solo vs team）是两个**正交开关**，按项目实际拷问决定，不要默认套用某一种。

## 交付清单

部署完成后，目标项目应留下：

- [ ] `AGENTS.md` 或 `CLAUDE.md`
- [ ] `feature_list.json`（功能尽量来自真实拷问；team 模式带 `owner`）
- [ ] `progress.md`
- [ ] `init.sh`
- [ ] `session-handoff.md`（多会话时）
- [ ] `<target>/.harness-helper/decisions.md` + `decisions.json`（本轮决策回溯）
- [ ] 若 `state.layout=versioned`：状态文件在 `.harness/versions/<版本>/`，`.harness/templates/` 有初始化模板
- [ ] 若 `collaboration.mode=team`：`.gitattributes` 含 `merge=union` 规则
- [ ] 若有 `.proposed` 文件：已提示用户 diff 合并

如果无法直接写文件，就把确切的文件内容和命令给用户。
