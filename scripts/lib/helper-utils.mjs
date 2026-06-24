// harness-helper 工具库 —— 仅使用 Node 内置模块,供 scan / generate / validate 复用。
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, chmod, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TEMPLATE_DIR = path.join(SKILL_ROOT, 'templates');
export const SUBSYSTEMS = ['instructions', 'state', 'verification', 'scope', 'lifecycle'];
export const SCRATCHPAD_DIR = '.harness-helper';

// --- 参数解析:支持 --key value 与 --key=value，未带值的标记记为 true ---
export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      args[key] = argv[i + 1];
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

export async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readText(filePath) {
  return readFile(filePath, 'utf8');
}

export async function readJson(filePath) {
  return JSON.parse(await readText(filePath));
}

export async function writeText(filePath, contents) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, 'utf8');
}

// 占位符渲染：把 {{KEY}} 替换为 replacements[KEY]。
export function renderTemplate(contents, replacements = {}) {
  let out = contents;
  for (const [key, value] of Object.entries(replacements)) {
    out = out.split(`{{${key}}}`).join(value);
  }
  return out;
}

export async function readTemplate(templateName) {
  return readText(path.join(TEMPLATE_DIR, templateName));
}

// 安全写盘：目标已存在则写 <name>.proposed，返回状态供上层提示用户 diff。
export async function writeProtected(targetPath, contents, { force = false, executable = false } = {}) {
  const alreadyExists = await exists(targetPath);
  if (alreadyExists && !force) {
    const proposedPath = `${targetPath}.proposed`;
    await writeText(proposedPath, contents);
    return { path: targetPath, proposedPath, status: 'proposed' };
  }
  await writeText(targetPath, contents);
  if (executable) {
    await chmod(targetPath, 0o755);
  }
  return { path: targetPath, status: force && alreadyExists ? 'overwritten' : 'written' };
}

// 解析版本号：跑 versionSource.command（一条打印版本号到 stdout 的 shell）。
// generate.mjs 与 init.sh 共用同一条命令，保证两边同步。失败返回 null。
export async function resolveVersion(root, command) {
  if (!command) return null;
  try {
    const { stdout } = await execFileAsync('bash', ['-c', command], { cwd: root });
    const value = stdout.trim().split('\n')[0].trim();
    return value || null;
  } catch {
    return null;
  }
}

// 把若干 gitattributes 行幂等地并入 <root>/.gitattributes：
// 已存在则只追加缺失行，不存在则新建。返回 { path, status, added }。
export async function mergeGitAttributes(root, lines) {
  const targetPath = path.join(root, '.gitattributes');
  const wanted = lines.map((line) => line.trimEnd()).filter(Boolean);
  let existing = '';
  if (await exists(targetPath)) existing = await readText(targetPath);
  const existingLines = new Set(existing.split('\n').map((line) => line.trim()));
  const missing = wanted.filter((line) => !existingLines.has(line.trim()));
  if (!missing.length) return { path: targetPath, status: 'unchanged', added: [] };
  const header = existing && !existing.endsWith('\n') ? '\n' : '';
  const block = `${existing}${header}${existing ? '\n' : ''}${missing.join('\n')}\n`;
  await writeText(targetPath, block);
  return { path: targetPath, status: existing ? 'appended' : 'written', added: missing };
}

export function detectPackageManager(root, explicit) {
  if (explicit) return explicit;
  if (existsSync(path.join(root, 'bun.lockb')) || existsSync(path.join(root, 'bun.lock'))) return 'bun';
  if (existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

export async function listFiles(root, { maxFiles = 1000 } = {}) {
  const ignored = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', '.harness-helper']);
  const results = [];

  async function walk(current, relative) {
    if (results.length >= maxFiles) return;
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      if (ignored.has(entry.name)) continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        results.push(rel);
      }
    }
  }

  await walk(root, '');
  return results.sort();
}

export async function detectProject(root) {
  const files = await listFiles(root, { maxFiles: 800 });
  const has = (name) => files.some((file) => file === name || file.endsWith(`/${name}`));
  const hasPrefix = (prefix) => files.some((file) => file.startsWith(prefix));
  const packageJsonPath = path.join(root, 'package.json');
  const packageJson = await exists(packageJsonPath).then((ok) => (ok ? readJson(packageJsonPath) : null));

  let stack = 'generic';
  if (packageJson) {
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
    if (deps.react || hasPrefix('src/renderer')) stack = 'typescript-react';
    else if (deps.typescript || has('tsconfig.json')) stack = 'typescript';
    else stack = 'node';
  } else if (has('pyproject.toml') || has('requirements.txt')) {
    stack = 'python';
  } else if (has('go.mod')) {
    stack = 'go';
  } else if (has('Cargo.toml')) {
    stack = 'rust';
  } else if (has('pom.xml')) {
    stack = 'java-maven';
  } else if (has('build.gradle') || has('build.gradle.kts')) {
    stack = 'java-gradle';
  } else if (files.some((file) => file.endsWith('.csproj') || file.endsWith('.sln'))) {
    stack = 'dotnet';
  }

  return {
    root,
    stack,
    packageJson,
    files,
    packageManager: detectPackageManager(root)
  };
}

export function verificationCommands(project, explicitPackageManager) {
  const pm = explicitPackageManager || project.packageManager || 'npm';
  const scripts = project.packageJson?.scripts ?? {};
  const run = (script) => {
    if (pm === 'npm') return `npm run ${script}`;
    if (pm === 'yarn') return `yarn ${script}`;
    return `${pm} run ${script}`;
  };

  if (project.stack === 'python') {
    return ['python -m pytest', 'python -m compileall .'];
  }
  if (project.stack === 'go') return ['go test ./...'];
  if (project.stack === 'rust') return ['cargo test'];
  if (project.stack === 'java-maven') return ['mvn test'];
  if (project.stack === 'java-gradle') return ['./gradlew test'];
  if (project.stack === 'dotnet') return ['dotnet test'];

  if (!project.packageJson) {
    return ['echo "未检测到项目清单；请把这一行替换成你的项目验证命令。"'];
  }

  const install = pm === 'npm' ? 'npm install' : pm === 'yarn' ? 'yarn install' : `${pm} install`;
  const candidates = [
    scripts.check ? run('check') : null,
    scripts.typecheck ? run('typecheck') : null,
    scripts['type-check'] ? run('type-check') : null,
    scripts.lint ? run('lint') : null,
    scripts.test ? (pm === 'npm' ? 'npm test' : `${pm} test`) : null,
    scripts.build ? run('build') : null
  ].filter(Boolean);

  return [install, ...dedupe(candidates)];
}

export function dedupe(values) {
  return [...new Set(values)];
}

export function packageScripts(project) {
  return project.packageJson?.scripts ?? {};
}

// --- git 状态：纯只读查询，失败则标记非 git 仓库 ---
export async function gitState(root) {
  try {
    const branch = (await execFileAsync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD']))
      .stdout.trim();
    const statusRaw = (await execFileAsync('git', ['-C', root, 'status', '--porcelain']))
      .stdout.trim();
    const dirtyCount = statusRaw ? statusRaw.split('\n').length : 0;
    return { isRepo: true, branch, dirtyCount };
  } catch {
    return { isRepo: false, branch: null, dirtyCount: 0 };
  }
}

// --- harness 产物在位探测 ---
const HARNESS_CANDIDATES = [
  'AGENTS.md',
  'CLAUDE.md',
  'feature_list.json',
  'feature-list.json',
  'progress.md',
  'session-handoff.md',
  'init.sh'
];

// 找到 .harness/versions/ 下"最新"的版本目录（按名称排序取最后一个）。
// 没有则返回 null。仅用于让 validate/scan 能定位 versioned 布局的状态文件。
export async function latestVersionDir(root) {
  const versionsRoot = path.join(root, '.harness', 'versions');
  if (!(await exists(versionsRoot))) return null;
  let entries = [];
  try {
    entries = await readdir(versionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  if (!dirs.length) return null;
  return path.join(versionsRoot, dirs[dirs.length - 1]);
}

// 加载 harness 产物供 scan/validate 评分。先看根目录（root 布局），
// 再看 .harness/versions/<latest>/（versioned 布局）。状态文件按逻辑名归一，
// 这样无论文件实际放哪，打分器都能找到——修掉 versioned 布局被误判缺失的问题。
export async function loadHarnessFiles(root) {
  const files = [];
  const seen = new Set();
  const add = (logicalName, content) => {
    if (seen.has(logicalName)) return;
    seen.add(logicalName);
    files.push({ path: logicalName, content });
  };

  for (const candidate of HARNESS_CANDIDATES) {
    const fullPath = path.join(root, candidate);
    if (await exists(fullPath)) add(candidate, await readText(fullPath));
  }

  const versionDir = await latestVersionDir(root);
  if (versionDir) {
    const versionedState = ['feature_list.json', 'feature-list.json', 'progress.md', 'session-handoff.md'];
    for (const candidate of versionedState) {
      const fullPath = path.join(versionDir, candidate);
      if (await exists(fullPath)) add(candidate, await readText(fullPath));
    }
  }

  return files;
}

// scan 用：把五子系统标成 present / partial / missing，作为 grill 的“针对性”依据。
export function subsystemPresence(files) {
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  const agents = byPath.get('AGENTS.md') || byPath.get('CLAUDE.md') || '';
  const featureList = byPath.get('feature_list.json') || byPath.get('feature-list.json') || '';
  const progress = byPath.get('progress.md') || '';
  const init = byPath.get('init.sh') || '';
  const handoff = byPath.get('session-handoff.md') || '';

  const grade = (hasFile, signals) => {
    if (!hasFile) return 'missing';
    return signals.every(Boolean) ? 'present' : 'partial';
  };

  return {
    instructions: grade(Boolean(agents), [
      /启动|startup|before writing|开始前/i.test(agents),
      /完成|done|definition of done/i.test(agents)
    ]),
    state: grade(Boolean(featureList), [
      isValidFeatureList(featureList),
      Boolean(progress)
    ]),
    verification: grade(Boolean(init), [
      /set -e/i.test(init),
      /(test|pytest|vitest|go test|cargo test|dotnet test|build|lint|check)/i.test(init + agents)
    ]),
    scope: grade(Boolean(agents) || Boolean(featureList), [
      /一次一个|one feature|单个功能|scope|范围/i.test(agents),
      /dependencies|依赖/i.test(featureList)
    ]),
    lifecycle: grade(Boolean(progress) || Boolean(handoff), [
      Boolean(handoff),
      /下次|next session|交接|handoff|结束前/i.test(progress + handoff + agents)
    ])
  };
}

function isValidFeatureList(text) {
  if (!text) return false;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.features) && parsed.features.every((feature) =>
      typeof feature.id === 'string'
      && typeof feature.name === 'string'
      && typeof feature.status === 'string');
  } catch {
    return false;
  }
}

// --- validate 用：五子系统结构打分 ---
export function scoreHarness(files) {
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  const allText = files.map((file) => `${file.path}\n${file.content}`).join('\n\n');
  const agents = byPath.get('AGENTS.md') || byPath.get('CLAUDE.md') || '';
  const featureList = byPath.get('feature_list.json') || byPath.get('feature-list.json') || '';
  const progress = byPath.get('progress.md') || '';
  const init = byPath.get('init.sh') || '';
  const handoff = byPath.get('session-handoff.md') || '';

  const checks = {
    instructions: [
      hasFile(byPath, ['AGENTS.md', 'CLAUDE.md'], '存在 agent 指令文件'),
      textHas(agents, ['启动', 'Startup', 'before writing', '开始前'], '记录了启动流程'),
      textHas(agents, ['完成的定义', 'Definition of Done', 'done only', '完成标准'], '记录了完成定义'),
      textHas(agents, ['验证命令', 'Verification', './init.sh', 'test', '验证'], '可发现验证命令'),
      textHas(agents, ['feature_list.json', 'progress.md'], '从指令文件路由到状态文件')
    ],
    state: [
      hasFile(byPath, ['feature_list.json', 'feature-list.json'], '存在功能追踪文件'),
      jsonFeatureList(featureList, '功能列表合法且字段完整'),
      hasFile(byPath, ['progress.md'], '存在进度日志'),
      textHas(progress, ['当前', 'Current State', '做了什么', '下一步', 'Next'], '进度日志支持重启'),
      textHas(handoff || progress, ['阻塞', 'Blockers', '文件', '下次', 'Next Session'], '交接记录了阻塞/文件/下一步')
    ],
    verification: [
      hasFile(byPath, ['init.sh'], '存在验证入口'),
      textHas(init, ['set -e'], '验证脚本快速失败'),
      textHas(init + agents, ['test', 'pytest', 'vitest', 'cargo test', 'go test', 'dotnet test'], '记录了测试命令'),
      textHas(init + agents, ['build', 'type', 'lint', 'compile', '构建', '类型'], '记录了静态/构建检查'),
      textHas(allText, ['证据', 'Evidence', '命令和输出', 'command and output'], '记录了验证证据')
    ],
    scope: [
      textHas(agents, ['一次一个', '单个功能', 'One feature', 'one-feature'], '存在一次一个功能的规则'),
      textHas(featureList, ['dependencies', '依赖'], '追踪了功能依赖'),
      textHas(agents + featureList, ['status', '状态'], '功能状态显式标注'),
      textHas(agents, ['范围', 'Stay in scope', 'scope'], '记录了范围边界'),
      textHas(agents, ['完成的定义', 'Definition of Done', '完成标准'], '完成闸门约束了收尾')
    ],
    lifecycle: [
      hasFile(byPath, ['init.sh'], '存在启动脚本'),
      textHas(agents, ['结束前', 'End of Session', 'Before ending', '会话结束'], '存在会话结束流程'),
      hasFile(byPath, ['session-handoff.md'], '存在会话交接模板'),
      textHas(progress + handoff, ['最后更新', 'Last Updated', '当前目标', '下一步建议', 'Recommended Next Step'], '存在会话重启标记'),
      textHas(agents + init, ['可重启', 'restartable', '干净', 'clean', '下一步', 'Next steps'], '记录了干净重启路径')
    ]
  };

  const subsystems = Object.fromEntries(Object.entries(checks).map(([name, subsystemChecks]) => {
    const passed = subsystemChecks.filter((check) => check.pass).length;
    const score = Math.max(1, Math.round((passed / subsystemChecks.length) * 5));
    return [name, { score, passed, total: subsystemChecks.length, checks: subsystemChecks }];
  }));

  const total = Object.values(subsystems).reduce((sum, item) => sum + item.score, 0);
  const overall = Math.round((total / (SUBSYSTEMS.length * 5)) * 100);
  const bottleneck = Object.entries(subsystems).sort((a, b) => a[1].score - b[1].score)[0][0];
  return { overall, bottleneck, subsystems };
}

function hasFile(byPath, names, message) {
  return { pass: names.some((name) => byPath.has(name)), message };
}

function textHas(text, needles, message) {
  const lower = text.toLowerCase();
  return { pass: needles.some((needle) => lower.includes(needle.toLowerCase())), message };
}

function jsonFeatureList(text, message) {
  return { pass: isValidFeatureList(text), message };
}

export const SUBSYSTEM_LABELS_ZH = {
  instructions: '指令 (Instructions)',
  state: '状态 (State)',
  verification: '验证 (Verification)',
  scope: '范围 (Scope)',
  lifecycle: '生命周期 (Lifecycle)'
};

export function formatScoreReport(result, root = '.') {
  const lines = [
    `Harness 结构评估：${root}`,
    `总分：${result.overall}/100`,
    `瓶颈子系统：${SUBSYSTEM_LABELS_ZH[result.bottleneck] || result.bottleneck}`,
    ''
  ];
  for (const [name, subsystem] of Object.entries(result.subsystems)) {
    lines.push(`${SUBSYSTEM_LABELS_ZH[name] || name}：${subsystem.score}/5（${subsystem.passed}/${subsystem.total}）`);
    for (const check of subsystem.checks) {
      lines.push(`  ${check.pass ? '通过' : '缺失'} ${check.message}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export { rename };
