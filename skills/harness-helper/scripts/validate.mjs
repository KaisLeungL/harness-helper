#!/usr/bin/env node
// validate.mjs —— 给目标项目的 harness 打五子系统结构分，用于部署后自检。
import path from 'node:path';
import {
  formatScoreReport,
  loadHarnessFiles,
  parseArgs,
  scoreHarness
} from './lib/helper-utils.mjs';

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`用法: node scripts/validate.mjs [--target DIR] [--json] [--min-score N]

给 harness 打五子系统结构分：
  指令 / 状态 / 验证 / 范围 / 生命周期

当总分低于 --min-score（默认 70）时退出码为 1。
注意：这是结构分，只说明 harness 是否齐备且自洽，
不能替代真实的 before/after agent 会话测试。`);
  process.exit(0);
}

const target = path.resolve(args.target || args._[0] || process.cwd());
const minScore = Number(args.minScore || 70);
const files = await loadHarnessFiles(target, { version: args.version });
const versionInfo = files.versionInfo;
const result = scoreHarness(files);

if (args.json) {
  console.log(JSON.stringify({ ...result, versionLayout: versionInfo }, null, 2));
} else {
  console.log(formatScoreReport(result, target));
  if (versionInfo && versionInfo.candidates.length) {
    if (versionInfo.source === 'ambiguous') {
      console.log(`注意：检测到多个版本目录 [${versionInfo.candidates.join(', ')}]，无法自动确定当前版本，本次未纳入版本化状态文件评分。请用 --version 指定，或确认 .harness-helper/decisions.json 的 versionSource。`);
    } else {
      console.log(`版本布局：已按 ${versionInfo.version} 评分（来源：${versionInfo.source}）。`);
    }
  }
  console.log('提示：结构分只衡量 harness 是否齐备自洽，真实效果仍需 before/after agent 会话验证。');
}

if (result.overall < minScore) {
  process.exitCode = 1;
}
