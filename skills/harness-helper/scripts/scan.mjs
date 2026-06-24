#!/usr/bin/env node
// scan.mjs —— 对目标项目做静态扫描，输出 JSON 事实，作为 grill 拷问的“针对性”依据。
import path from 'node:path';
import {
  detectPackageManager,
  detectProject,
  gitState,
  loadHarnessFiles,
  packageScripts,
  parseArgs,
  subsystemPresence,
  verificationCommands
} from './lib/helper-utils.mjs';

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`用法: node scripts/scan.mjs [--target DIR] [--package-manager npm|pnpm|yarn|bun] [--pretty]

扫描项目并输出 JSON 事实：
  stack / packageManager / packageScripts
  verificationCommands（推荐验证命令）
  gitState（是否 git 仓库 / 分支 / 未提交数）
  subsystems（五子系统在位：present | partial | missing）

供 harness-helper 的 grill 阶段读取，决定每个子系统问深还是一句带过。`);
  process.exit(0);
}

const target = path.resolve(args.target || args._[0] || process.cwd());
const project = await detectProject(target);
project.packageManager = detectPackageManager(target, args.packageManager);

const harnessFiles = await loadHarnessFiles(target, { version: args.version });
const versionInfo = harnessFiles.versionInfo;
const result = {
  target,
  stack: project.stack,
  packageManager: project.packageManager,
  packageScripts: packageScripts(project),
  verificationCommands: args.packageManager
    ? verificationCommands(project, args.packageManager)
    : verificationCommands(project),
  gitState: await gitState(target),
  existingHarnessFiles: harnessFiles.map((file) => file.actualPath || file.path),
  subsystems: subsystemPresence(harnessFiles)
};

// versioned 布局：报告版本解析情况。source=ambiguous 时附候选，交由调用方（LLM）判断当前版本。
if (versionInfo && versionInfo.candidates.length) {
  result.versionLayout = {
    resolvedVersion: versionInfo.version,
    source: versionInfo.source,
    candidates: versionInfo.candidates
  };
  if (versionInfo.source === 'ambiguous') {
    result.versionLayout.note = '存在多个版本目录且无法从 decisions.json 的 versionSource 解析当前版本。请根据项目版本号管理方式判断哪个是当前版本，或用 --version 显式指定。';
  }
}

console.log(JSON.stringify(result, null, 2));
