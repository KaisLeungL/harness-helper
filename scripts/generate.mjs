#!/usr/bin/env node
// generate.mjs —— 读 .harness-helper/decisions.json，渲染中文模板生成 5 件 harness 产物。
// 同名文件已存在时不覆盖，改写 <name>.proposed，并在结尾提示用户 diff 合并。
import path from 'node:path';
import {
  SCRATCHPAD_DIR,
  exists,
  parseArgs,
  readJson,
  readTemplate,
  renderTemplate,
  writeProtected
} from './lib/helper-utils.mjs';

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`用法: node scripts/generate.mjs [--target DIR] [--decisions FILE] [--force]

读取决策文件（默认 <target>/.harness-helper/decisions.json）并生成：
  AGENTS.md 或 CLAUDE.md
  feature_list.json
  progress.md
  session-handoff.md
  init.sh

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
const results = [];

// --- AGENTS.md / CLAUDE.md ---
const agentsTemplate = await readTemplate('agents.md');
const agentsContent = renderTemplate(agentsTemplate, {
  AGENT_FILE_NAME: agentFile,
  PROJECT_PURPOSE: decisions.instructions.purpose || '为可靠的 agent 辅助开发提供项目 harness。',
  WORKING_RULES: renderWorkingRules(decisions.scope),
  DONE_CRITERIA: renderDoneCriteria(decisions.scope),
  END_OF_SESSION: renderEndOfSession(decisions.lifecycle),
  PRIMARY_VERIFICATION_COMMAND: './init.sh',
  VERIFICATION_COMMANDS: commands.map((command) => `- \`${command}\``).join('\n')
});
results.push(await writeProtected(path.join(target, agentFile), maybeInjectStartupSteps(agentsContent, decisions.instructions.startupSteps), { force }));

// --- feature_list.json ---
const featureList = {
  features: decisions.state.features.map((feature) => ({
    id: feature.id,
    name: feature.name,
    description: feature.description,
    dependencies: feature.dependencies || [],
    status: feature.status || 'not-started',
    evidence: feature.evidence || ''
  }))
};
results.push(await writeProtected(
  path.join(target, 'feature_list.json'),
  `${JSON.stringify(featureList, null, 2)}\n`,
  { force }
));

// --- progress.md ---
results.push(await writeProtected(
  path.join(target, 'progress.md'),
  await readTemplate('progress.md'),
  { force }
));

// --- session-handoff.md（仅当 lifecycle.useHandoff 不为 false）---
if (decisions.lifecycle.useHandoff !== false) {
  results.push(await writeProtected(
    path.join(target, 'session-handoff.md'),
    await readTemplate('session-handoff.md'),
    { force }
  ));
}

// --- init.sh ---
results.push(await writeProtected(
  path.join(target, 'init.sh'),
  initScriptFromCommands(commands),
  { force, executable: true }
));

// --- 报告 ---
console.log(`已为 ${target} 生成 harness。`);
console.log(`指令文件：${agentFile}`);
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
  return errors;
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

function initScriptFromCommands(commands) {
  const body = commands
    .map((command) => `echo "=== ${command.replaceAll('"', '\\"')} ==="\n${command}`)
    .join('\n\n');
  return `#!/bin/bash
set -e

echo "=== Harness 初始化 ==="

${body}

echo "=== 验证完成 ==="
echo ""
echo "下一步："
echo "1. 读 feature_list.json 查看当前功能状态"
echo "2. 挑一个未完成功能"
echo "3. 只实现那一个功能"
echo "4. 声称完成前重新跑验证"
`;
}
