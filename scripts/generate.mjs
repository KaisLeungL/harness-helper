#!/usr/bin/env node
// generate.mjs —— 读 .harness-helper/decisions.json，渲染中文模板生成 harness 产物。
// 支持两个正交开关：
//   state.layout: root（状态文件放根目录）| versioned（放 .harness/versions/<版本>/）
//   collaboration.mode: solo（普通状态文件）| team（## @author 分节 + merge=union 追加式）
// 同名文件已存在时不覆盖，改写 <name>.proposed，并在结尾提示用户 diff 合并。
import path from 'node:path';
import {
  SCRATCHPAD_DIR,
  exists,
  mergeGitAttributes,
  parseArgs,
  readJson,
  readTemplate,
  renderTemplate,
  resolveVersion,
  writeProtected,
  writeText
} from './lib/helper-utils.mjs';

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`用法: node scripts/generate.mjs [--target DIR] [--decisions FILE] [--force]

读取决策文件（默认 <target>/.harness-helper/decisions.json）并生成：
  AGENTS.md 或 CLAUDE.md
  feature_list.json / progress.md / session-handoff.md（位置由 state.layout 决定）
  init.sh
  .gitattributes（仅 collaboration.mode=team，merge=union）
  .harness/templates/*（仅 state.layout=versioned，供 init.sh 初始化新版本）

已存在的同名文件默认不覆盖，改写为 <name>.proposed 供 diff 合并。
传 --force 才会直接覆盖。`);
  process.exit(0);
}

const target = path.resolve(args.target || args._[0] || process.cwd());
const decisionsPath = path.resolve(args.decisions || path.join(target, SCRATCHPAD_DIR, 'decisions.json'));
const force = Boolean(args.force);

if (!await exists(decisionsPath)) {
  console.error(`找不到决策文件：${decisionsPath}`);
  console.error('请先完成 grill 拷问、写出 decisions.json，再运行本脚本。');
  process.exit(1);
}

const decisions = await readJson(decisionsPath);
const errors = validateDecisions(decisions);
if (errors.length) {
  console.error('决策文件结构有问题：');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

const agentFile = decisions.instructions.agentFile || 'AGENTS.md';
const commands = decisions.verification.commands;
const layout = decisions.state.layout === 'versioned' ? 'versioned' : 'root';
const teamMode = decisions.collaboration?.mode === 'team';
const versionSource = decisions.state.versionSource || {};
const useHandoff = decisions.lifecycle.useHandoff !== false;

// versioned 布局：现在解析一次版本号，用于初始化当前版本目录。
let version = null;
if (layout === 'versioned') {
  version = await resolveVersion(target, versionSource.command) || 'unversioned';
  if (version === 'unversioned') {
    console.warn('注意：versionSource.command 未配置或解析失败，当前版本目录命名为 unversioned。');
  }
}

// 状态文件路径（相对 target）。
const stateDir = layout === 'versioned' ? `.harness/versions/${version}` : '';
const rel = (name) => (stateDir ? `${stateDir}/${name}` : name);
const featureListPath = rel('feature_list.json');
const progressPath = rel('progress.md');
const handoffPath = rel('session-handoff.md');
const versionSuffix = layout === 'versioned' ? ` — 版本 ${version}` : '';

const results = [];

// --- AGENTS.md / CLAUDE.md ---
const agentsTemplate = await readTemplate('agents.md');
const agentsContent = renderTemplate(agentsTemplate, {
  AGENT_FILE_NAME: agentFile,
  PROJECT_PURPOSE: decisions.instructions.purpose || '为可靠的 agent 辅助开发提供项目 harness。',
  INIT_VERSION_NOTE: layout === 'versioned'
    ? `（它会解析当前版本号${versionSource.label ? `（来自 ${versionSource.label}）` : ''}，定位本版本状态目录）`
    : '',
  FEATURE_LIST_PATH: featureListPath,
  PROGRESS_PATH: progressPath,
  STATE_SECTION: renderStateSection({ layout, teamMode, version, versionSource, featureListPath, progressPath, handoffPath, useHandoff }),
  WORKING_RULES: renderWorkingRules(decisions.scope),
  DONE_CRITERIA: renderDoneCriteria(decisions.scope),
  END_OF_SESSION: renderEndOfSession(decisions.lifecycle),
  PRIMARY_VERIFICATION_COMMAND: './init.sh',
  VERIFICATION_COMMANDS: commands.map((command) => `- \`${command}\``).join('\n')
});
results.push(await writeProtected(path.join(target, agentFile), maybeInjectStartupSteps(agentsContent, decisions.instructions.startupSteps), { force }));

// --- feature_list.json ---
const featureListContent = buildFeatureList(decisions, { teamMode, layout, version });
results.push(await writeProtected(path.join(target, featureListPath), featureListContent, { force }));

// --- progress.md ---
const progressTemplate = await readTemplate(teamMode ? 'progress.team.md' : 'progress.md');
results.push(await writeProtected(
  path.join(target, progressPath),
  renderTemplate(progressTemplate, { VERSION: version || '', VERSION_SUFFIX: versionSuffix }),
  { force }
));

// --- session-handoff.md（仅当 lifecycle.useHandoff 不为 false）---
if (useHandoff) {
  const handoffTemplate = await readTemplate(teamMode ? 'session-handoff.team.md' : 'session-handoff.md');
  results.push(await writeProtected(
    path.join(target, handoffPath),
    renderTemplate(handoffTemplate, { VERSION: version || '', VERSION_SUFFIX: versionSuffix }),
    { force }
  ));
}

// --- .harness/templates/*（versioned 布局：供 init.sh 初始化新版本目录）---
if (layout === 'versioned') {
  const featureTemplate = teamMode ? await readTemplate('feature-list.team.json') : await readTemplate('feature-list.json');
  const progressTpl = await readTemplate(teamMode ? 'progress.team.md' : 'progress.md');
  const handoffTpl = await readTemplate(teamMode ? 'session-handoff.team.md' : 'session-handoff.md');
  results.push(await writeProtected(path.join(target, '.harness/templates/feature-list.json.template'), featureTemplate, { force }));
  results.push(await writeProtected(path.join(target, '.harness/templates/progress.md.template'), progressTpl, { force }));
  results.push(await writeProtected(path.join(target, '.harness/templates/session-handoff.md.template'), handoffTpl, { force }));
}

// --- init.sh ---
results.push(await writeProtected(
  path.join(target, 'init.sh'),
  buildInitScript({ commands, layout, teamMode, versionSource, useHandoff }),
  { force, executable: true }
));

// --- .gitattributes（team 布局：progress/handoff 走 merge=union）---
let gitattrResult = null;
if (teamMode) {
  const progressGlob = layout === 'versioned' ? '.harness/versions/**/progress.md' : 'progress.md';
  const handoffGlob = layout === 'versioned' ? '.harness/versions/**/session-handoff.md' : 'session-handoff.md';
  const lines = ['# Harness 状态文件：追加式日志，多人同时追加各自 ## @author 节点。', '# union 合并 = 双方新增行都保留、永不冲突。仅对"只追加不改写"的文件安全。', `${progressGlob} merge=union`];
  if (useHandoff) lines.push(`${handoffGlob} merge=union`);
  gitattrResult = await mergeGitAttributes(target, lines);
}

// --- 报告 ---
console.log(`已为 ${target} 生成 harness。`);
console.log(`指令文件：${agentFile}`);
console.log(`状态布局：${layout}${layout === 'versioned' ? `（当前版本 ${version}）` : ''} ｜ 协作模式：${teamMode ? 'team' : 'solo'}`);
console.log('验证命令：');
for (const command of commands) console.log(`  - ${command}`);
console.log('');

const proposed = [];
for (const result of results) {
  const label = {
    written: '已写入',
    overwritten: '已覆盖',
    proposed: '已存在→另存 .proposed'
  }[result.status] || result.status;
  console.log(`${label}  ${path.relative(target, result.path)}`);
  if (result.status === 'proposed') proposed.push(result);
}

if (gitattrResult) {
  const label = { written: '已写入', appended: '已追加', unchanged: '已是最新' }[gitattrResult.status] || gitattrResult.status;
  console.log(`${label}  .gitattributes（merge=union）`);
}

if (proposed.length) {
  console.log('');
  console.log('以下文件已存在，新内容写到了 .proposed，请人工 diff 后合并：');
  for (const result of proposed) {
    const rel = path.relative(target, result.path);
    console.log(`  diff ${rel} ${rel}.proposed`);
  }
}

console.log('');
console.log('下一步：运行 validate.mjs 给产出的 harness 打个结构分。');
console.log(`  node <skill>/scripts/validate.mjs --target ${target}`);

// --- 本地辅助 ---

function validateDecisions(decisions) {
  const errors = [];
  if (!decisions || typeof decisions !== 'object') return ['decisions 不是对象'];
  if (!decisions.instructions?.agentFile) errors.push('instructions.agentFile 缺失');
  if (!decisions.instructions?.purpose) errors.push('instructions.purpose 缺失');
  if (!Array.isArray(decisions.state?.features) || decisions.state.features.length === 0) {
    errors.push('state.features 缺失或为空');
  }
  if (!Array.isArray(decisions.verification?.commands) || decisions.verification.commands.length === 0) {
    errors.push('verification.commands 缺失或为空');
  }
  if (!decisions.scope || typeof decisions.scope !== 'object') errors.push('scope 缺失');
  if (!decisions.lifecycle || typeof decisions.lifecycle !== 'object') errors.push('lifecycle 缺失');
  if (decisions.state?.layout === 'versioned' && !decisions.state?.versionSource?.command) {
    errors.push('state.layout=versioned 但缺 state.versionSource.command（解析版本号的 shell 命令）');
  }
  return errors;
}

function buildFeatureList(decisions, { teamMode, layout, version }) {
  const featureList = {};
  if (layout === 'versioned') featureList.version = version;
  if (teamMode) {
    featureList.note = '一个功能只由一人维护其条目（owner 字段），减少合并冲突。status: not-started | in-progress | pass | fail';
  }
  featureList.features = decisions.state.features.map((feature) => {
    const entry = { id: feature.id, name: feature.name, description: feature.description };
    if (teamMode) entry.owner = feature.owner || 'your-git-username';
    entry.dependencies = feature.dependencies || [];
    entry.status = feature.status || 'not-started';
    entry.evidence = feature.evidence || '';
    return entry;
  });
  return `${JSON.stringify(featureList, null, 2)}\n`;
}

function renderStateSection({ layout, teamMode, version, versionSource, featureListPath, progressPath, handoffPath, useHandoff }) {
  const lines = ['## 状态文件'];
  if (layout === 'versioned') {
    const src = versionSource?.label ? `（取自 ${versionSource.label}）` : '';
    lines.push('', `状态文件按版本维度组织在 \`.harness/versions/<版本>/\`，版本号${src}当前为 \`${version}\`。\`.harness/templates/\` 存放新版本的初始化模板，\`init.sh\` 会在版本目录缺失时自动创建。`);
  }
  lines.push('');
  lines.push(`- \`${featureListPath}\` —— 功能状态追踪（唯一事实源）${teamMode ? '；id 对齐你们的工单号，`owner` 字段标记负责人，一个工单只由一人维护其条目' : ''}`);
  if (teamMode) {
    lines.push(`- \`${progressPath}\` —— 进度日志，用 \`## @<git user.name>\` 分节，\`merge=union\` 合并。**只在自己节点下追加，不改写**（见文件顶部规则）`);
    if (useHandoff) lines.push(`- \`${handoffPath}\` —— 会话交接，同为追加式 + \`merge=union\``);
  } else {
    lines.push(`- \`${progressPath}\` —— 会话连续性日志`);
    if (useHandoff) lines.push(`- \`${handoffPath}\` —— 可选，用于较大的会话`);
  }
  lines.push('- `init.sh` —— 标准启动与验证路径');
  if (teamMode) {
    lines.push('', '**协作纪律（关键）**：`progress` / `session-handoff` 走 union 合并，只能追加不能改写——回头改历史行会被 union 复制成重复行。改写类操作只允许针对 `feature_list.json`（结构化，正常合并）。');
  }
  return lines.join('\n');
}

function renderWorkingRules(scope) {
  const rules = scope?.extraRules || [];
  if (!rules.length) return '';
  return rules.map((rule) => `- ${rule}`).join('\n');
}

function renderDoneCriteria(scope) {
  const criteria = scope?.doneCriteria?.length
    ? scope.doneCriteria
    : [
        '目标行为已实现',
        '所需验证确实跑过（测试 / lint / 类型检查）',
        '证据记录在 feature_list.json 或 progress.md',
        '仓库仍可从标准启动路径重启'
      ];
  return criteria.map((item) => `- [ ] ${item}`).join('\n');
}

function renderEndOfSession(lifecycle) {
  const steps = lifecycle?.endOfSessionSteps?.length
    ? lifecycle.endOfSessionSteps
    : [
        '更新 progress.md 记录当前状态',
        '更新 feature_list.json 的功能状态',
        '记录尚未解决的风险或阻塞',
        '工作处于安全状态后用清晰的信息提交',
        '让仓库干净到下次会话能立刻跑 ./init.sh'
      ];
  return steps.map((step, index) => `${index + 1}. ${step}`).join('\n');
}

function maybeInjectStartupSteps(content, startupSteps) {
  if (!startupSteps?.length) return content;
  const extra = startupSteps.map((step) => `   - ${step}`).join('\n');
  return content.replace(
    '6. **看最近提交**：`git log --oneline -5`',
    `6. **看最近提交**：\`git log --oneline -5\`\n\n额外启动步骤：\n${extra}`
  );
}

function buildInitScript({ commands, layout, teamMode, versionSource, useHandoff }) {
  const verifyBody = commands
    .map((command) => `echo "=== ${command.replaceAll('"', '\\"')} ==="\n${command}`)
    .join('\n\n');
  const authorLine = teamMode ? 'echo "你的 author：$(git config user.name)"\n' : '';

  if (layout !== 'versioned') {
    return `#!/bin/bash
set -e

echo "=== Harness 初始化 ==="
${authorLine}
${verifyBody}

echo "=== 验证完成 ==="
echo ""
echo "下一步："
echo "1. 读 feature_list.json 查看当前功能状态"
echo "2. 挑一个未完成功能${teamMode ? '（owner 为自己）' : ''}"
echo "3. 只实现那一个功能"
echo "4. 声称完成前重新跑验证${teamMode ? '，并在 progress.md 自己节点下追加进展' : ''}"
`;
  }

  const versionCommand = versionSource.command || 'echo unversioned';
  const handoffInit = useHandoff
    ? '  sed -e "s|{{VERSION}}|$VERSION|g" -e "s|{{VERSION_SUFFIX}}|$VSUFFIX|g" "$TPL/session-handoff.md.template" > "$VDIR/session-handoff.md"\n'
    : '';
  return `#!/bin/bash
set -e

echo "=== Harness 初始化 ==="

# 解析当前版本号（与 generate.mjs 共用同一条命令，保证两边同步）
VERSION=$(${versionCommand})
if [ -z "$VERSION" ]; then
  echo "!! 无法解析版本号；请检查 init.sh 顶部的版本解析命令"
  exit 1
fi
echo "当前版本：$VERSION"

# 定位本版本状态目录，缺失则从模板初始化
VDIR=".harness/versions/$VERSION"
TPL=".harness/templates"
if [ ! -d "$VDIR" ]; then
  echo "本版本状态目录不存在，从模板初始化：$VDIR"
  mkdir -p "$VDIR"
  VSUFFIX=" — 版本 $VERSION"
  sed -e "s|{{VERSION}}|$VERSION|g" -e "s|{{VERSION_SUFFIX}}|$VSUFFIX|g" "$TPL/feature-list.json.template" > "$VDIR/feature_list.json"
  sed -e "s|{{VERSION}}|$VERSION|g" -e "s|{{VERSION_SUFFIX}}|$VSUFFIX|g" "$TPL/progress.md.template"       > "$VDIR/progress.md"
${handoffInit}fi
echo "状态目录：$VDIR"
${authorLine}
${verifyBody}

echo "=== 验证完成 ==="
echo ""
echo "下一步："
echo "1. 读 $VDIR/feature_list.json 查看当前功能状态"
echo "2. 挑一个未完成功能${teamMode ? '（owner 为自己）' : ''}"
echo "3. 只实现那一个功能"
echo "4. 声称完成前重新跑验证${teamMode ? '，并在 $VDIR/progress.md 自己节点下追加进展' : ''}"
`;
}
