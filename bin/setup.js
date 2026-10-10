#!/usr/bin/env node
/**
 * bin/setup.js — 一条命令完成「环境自检 + 配置片段 + 下一步指引」。
 *
 * 设计约束（刻意的）：
 *  1) **默认只读**：绝不修改 `~/.codex/config.toml` 与 `~/.dsh/**`；只检测存在性与给出可粘贴片段。
 *     要写必须显式 `--write-codex`（且仍会先备份）。
 *  2) **自检结果可复制**：每项检查都打印「命令 + 期望」，而不是只说"OK/失败"。
 *  3) **未就绪必须给原因**：不静默通过（沿用 /healthz 的 regime）。
 *  4) 退出码：0 = 全部就绪；3 = 有未就绪项（脚本/CI 可判定）；2 = 用法错误。
 *
 * 只依赖 node: 内置模块，保证在任何环境都能跑起来给出诊断。
 * （t32 新增的「凭证治理」只读检测复用 `bin/oauth-login.js` 的 `describeCredentialStatus()`，
 *   它同样只做 fs 读取——不创建目录、不写文件、不访问网络。）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describeCredentialStatus } from './oauth-login.js';
import { defaultCredentialsPath } from '../src/credentials/paths.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const HOME = process.env.USERPROFILE || process.env.HOME || '';

// `--manifest <path>`：本向导默认只看仓库根的 trace.manifest.json；
// 允许指定其它清单（便于把自检跑在隔离清单上，也让测试可证伪）。
const argv = process.argv.slice(2);
let manifestPathArg = null;
let fromAgentArg = null;
let importPathArg = null;
let runIdArg = null;
let writeManifest = false;
for (let i = 0; i < argv.length; i += 1) {
  const token = argv[i];
  const eqIndex = token.startsWith('--') ? token.indexOf('=') : -1;
  const name = eqIndex > 0 ? token.slice(0, eqIndex) : token;
  const inline = eqIndex > 0 ? token.slice(eqIndex + 1) : null;
  const value = () => {
    if (inline !== null) return inline;
    if (argv[i + 1] && !argv[i + 1].startsWith('--')) { i += 1; return argv[i]; }
    return null;
  };
  if (name === '--manifest') { manifestPathArg = value(); }
  else if (name === '--from-agent') { fromAgentArg = value(); }
  else if (name === '--import') { importPathArg = value(); }
  else if (name === '--run-id') { runIdArg = value(); }
  else if (name === '--write-manifest') { writeManifest = true; }
  else if (name === '--help') {
    console.log('用法: node bin/setup.js [--manifest <path>] [--from-agent codex|dsh] [--import <path>] [--run-id <id>] [--write-manifest]');
    console.log('  无参数：环境自检 + 配置片段 + 下一步指引。**默认只读**：不会修改你的任何配置文件。');
    console.log('  --from-agent codex|dsh   只读导入你**现有**的 agent MCP 配置（~/.codex/config.toml 或');
    console.log('                           ~/.dsh/profiles/desktop/cordis.patch.yml），生成 Gateway 上游清单 +');
    console.log('                           agent 侧替换片段（默认只打印，不改任何文件）。');
    console.log('  --import <path>          指定要导入的 agent 配置文件（配合 --from-agent 可显式指明类型）');
    console.log('  --run-id <id>            覆盖自动生成的 experimentRunId');
    console.log('  --write-manifest         把生成的清单**写进本仓库**（默认 trace.manifest.json，或 --manifest 指定的路径）；');
    console.log('                           已存在时先备份 .bak，并打印差异摘要。绝不写用户目录里的任何文件。');
    console.log('  退出码：0 成功 / 3 有未就绪项或文件不存在 / 2 用法或配置错误');
    process.exit(0);
  } else if (token.startsWith('-')) {
    console.error(`未知参数：${token}（用 --help 查看用法）`);
    process.exit(2);
  }
}

// ────────────── 0. 只读导入现有 agent 配置（--from-agent / --import）──────────────
if (fromAgentArg || importPathArg) {
  const {
    AGENT_KINDS,
    AgentImportError,
    defaultAgentConfigPath,
    importAgentConfig,
  } = await import('../src/setup/import_agents.js');
  const { loadManifest } = await import('../src/gateway/manifest.js');

  if (fromAgentArg && !AGENT_KINDS.includes(fromAgentArg)) {
    console.error(`配置错误：--from-agent 只能是 ${AGENT_KINDS.join(' | ')}（当前 ${JSON.stringify(fromAgentArg)}）`);
    process.exit(2);
  }
  const sourcePath = importPathArg
    ? (path.isAbsolute(importPathArg) ? importPathArg : path.join(REPO, importPathArg))
    : defaultAgentConfigPath(fromAgentArg ?? 'codex', process.env);
  if (!exists(sourcePath)) {
    console.error(`无法导入：文件不存在 ${sourcePath}`);
    console.error('  → 确认 agent 已经配置过 MCP；或用 --import <path> 指定路径');
    process.exit(3);
  }

  const beforeStat = fs.statSync(sourcePath);
  const beforeText = fs.readFileSync(sourcePath, 'utf8');
  /** @type {Record<string, any>} */
  let imported;
  try {
    imported = importAgentConfig({
      kind: fromAgentArg ?? undefined,
      filePath: sourcePath,
      text: beforeText,
      runId: runIdArg ?? undefined,
      repoRoot: REPO,
      nodePath: process.execPath,
    });
  } catch (error) {
    const known = error instanceof AgentImportError;
    console.error(`导入失败：${error instanceof Error ? error.message : String(error)}`);
    if (known) console.error(`  → 原因代码：${error.code}；用 --help 看支持的形状，或手工编辑 trace.manifest.json`);
    process.exit(2);
  }

  // 只读承诺：源文件必须一字未改（字节、mtime、hash 三者都比）
  const afterStat = fs.statSync(sourcePath);
  const afterText = fs.readFileSync(sourcePath, 'utf8');
  const readOnlyOk =
    afterStat.size === beforeStat.size && afterStat.mtimeMs === beforeStat.mtimeMs && afterText === beforeText;

  console.log(`\n── 只读导入：${imported.kind} ──`);
  console.log(`  源文件：${sourcePath}`);
  console.log(`  解析到 ${imported.servers.length} 个 server（stdio ${imported.upstreams.filter((u) => u.transport === 'stdio').length} / http ${imported.upstreams.filter((u) => u.transport === 'streamable-http').length}）`);
  console.log(`  只读承诺：源文件未被修改 = ${readOnlyOk ? '是' : '否（这是缺陷！）'}`);
  for (const warning of imported.warnings) console.log(`  [注意] ${warning}`);
  console.log(`\n── 生成的 Gateway 上游清单（写入前请确认）──`);
  console.log(JSON.stringify(imported.manifest, null, 2));
  // 「生成对象能过清单校验」——用一个临时文件做真实校验（比在内存里假装校验更可信）
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-import-'));
  const probePath = path.join(probeDir, 'trace.manifest.json');
  fs.writeFileSync(probePath, `${JSON.stringify(imported.manifest, null, 2)}\n`, 'utf8');
  const probe = loadManifest({ manifestPath: probePath, env: process.env, cwd: REPO });
  fs.rmSync(probeDir, { recursive: true, force: true });
  console.log(`\n  生成清单自校验（loadManifest）：${probe.ok ? '通过' : '不通过'}`);
  if (!probe.ok) for (const error of probe.errors) console.log(`    !! ${error}`);

  console.log(`\n── agent 侧替换片段（**只读指引**：本命令不会替你改写 agent 配置）──`);
  if (imported.kind === 'codex') console.log(imported.snippets.stdioToml);
  else console.log(imported.snippets.stdioYaml);
  console.log(`\n── 若用 trace-manager（推荐：单进程 + 一个 run id），agent 侧改用 HTTP 形态 ──`);
  console.log(imported.snippets.httpYaml);
  console.log(`\n── 粘贴指引 ──`);
  for (const line of imported.snippets.guidance) console.log(`  ${line}`);

  if (writeManifest) {
    const target = manifestPathArg
      ? (path.isAbsolute(manifestPathArg) ? manifestPathArg : path.join(REPO, manifestPathArg))
      : path.join(REPO, 'trace.manifest.json');
    const relative = path.relative(REPO, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      console.error(`\n--write-manifest 只能写本仓库内的清单（拒绝写 ${target}）：绝不写仓库外的任何文件`);
      process.exit(2);
    }
    let diffSummary = '（目标不存在，直接新建）';
    if (exists(target)) {
      const previous = readJsonSafe(target);
      fs.copyFileSync(target, `${target}.bak`);
      if (previous) {
        const beforeNames = (previous.upstreams ?? []).map((u) => u.serverName);
        const afterNames = imported.manifest.upstreams.map((u) => u.serverName);
        const added = afterNames.filter((name) => !beforeNames.includes(name));
        const removed = beforeNames.filter((name) => !afterNames.includes(name));
        diffSummary =
          `上游：${beforeNames.length} → ${afterNames.length}` +
          (added.length ? `，新增 ${added.join('/')}` : '') +
          (removed.length ? `，移除 ${removed.join('/')}` : '') +
          `；experimentRunId：${previous.experimentRunId ?? '(无)'} → ${imported.manifest.experimentRunId}`;
      } else {
        diffSummary = '（旧文件无法解析，已原样备份为 .bak）';
      }
    }
    fs.writeFileSync(target, `${JSON.stringify(imported.manifest, null, 2)}\n`, 'utf8');
    console.log(`\n已写入 ${target}`);
    if (exists(`${target}.bak`)) console.log(`已备份旧清单到 ${target}.bak`);
    console.log(`差异摘要：${diffSummary}`);
  } else {
    console.log(`\n（未写任何文件。要落盘到仓库内清单：node bin\\setup.js --from-agent ${imported.kind} --write-manifest）`);
  }
  process.exit(0);
}

const OK = '  [就绪]';
const NG = '  [未就绪]';
const WARN = '  [注意]';

/** @type {{name:string, ok:boolean, detail:string, fix?:string}[]} */
const results = [];
function record(name, ok, detail, fix) {
  results.push({ name, ok, detail, fix });
  const tag = ok ? OK : NG;
  console.log(`${tag} ${name}：${detail}`);
  if (!ok && fix) console.log(`          → ${fix}`);
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

// ───────────────────────────── 1. 运行环境 ─────────────────────────────
console.log('跨 APP 数据流追踪平台 · 环境自检');
console.log('（本命令默认只读：不会修改你的任何配置文件）\n');
console.log('── 运行环境 ──');

const major = Number(process.versions.node.split('.')[0]);
record(
  'Node 版本',
  major >= 24,
  `${process.version}${major >= 24 ? '' : '（本项目要求 >= 24；npm scripts 已固定使用捆绑 Node 24，直接调 node 时请注意）'}`,
  '用 npm run <script> 运行（会走 tools/node.js 固定到捆绑 Node 24），或直接使用捆绑 node.exe',
);

record('仓库根', exists(path.join(REPO, 'package.json')), REPO);

const nodeModules = path.join(REPO, 'node_modules');
record(
  '依赖安装',
  exists(nodeModules),
  exists(nodeModules) ? 'node_modules 存在' : 'node_modules 不存在',
  'cmd /c "cd /d ' + REPO + ' && npm install --no-audit --no-fund --cache=' + path.join(REPO, '.npm-cache') + '"',
);

// ───────────────────────────── 2. 实验清单 ─────────────────────────────
console.log('\n── 实验清单（唯一真源）──');
const manifestPath = manifestPathArg
  ? (path.isAbsolute(manifestPathArg) ? manifestPathArg : path.join(REPO, manifestPathArg))
  : path.join(REPO, 'trace.manifest.json');
if (!exists(manifestPath)) {
  record('trace.manifest.json', false, '不存在', '从示例创建：复制仓库内的 trace.manifest.json 并改 experimentRunId');
} else {
  const m = readJsonSafe(manifestPath);
  if (!m) {
    record('trace.manifest.json', false, '无法解析为 JSON', '检查文件语法');
  } else {
    record('trace.manifest.json', true, `experimentRunId=${m.experimentRunId} · clientLabel=${m.clientLabel} · 上游 ${Array.isArray(m.upstreams) ? m.upstreams.length : 0} 个`);
    // 凭证类模板变量自检：缺了就会在启动时才报错，提前告知更好。
    // 约定：以 `_` 开头的键是**文档**（示例/说明/用法），不参与取值 —— 否则文档里举例的
    // `${ENV_NAME}` 会被误报成"必须设置的环境变量"（2026-10-03 实测到该误报）。
    const needEnv = [];
    const walk = (v) => {
      if (typeof v === 'string') {
        for (const mm of v.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) needEnv.push(mm[1]);
      } else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          if (k.startsWith('_')) continue;
          walk(x);
        }
      }
    };
    walk(m);
    if (needEnv.length) {
      const missing = [...new Set(needEnv)].filter((n) => !process.env[n]);
      record(
        '清单引用的环境变量',
        missing.length === 0,
        missing.length === 0 ? `${[...new Set(needEnv)].join(', ')} 均已设置` : `未设置：${missing.join(', ')}（清单拒绝用空串继续，启动会报配置错误）`,
        missing.length ? '设置这些环境变量后再启动（令牌只从环境读，不要写进文件）' : undefined,
      );
    }
    const host = m.http?.host;
    if (host && host !== '127.0.0.1') {
      record('http.host 合规', false, `${host}（只允许 127.0.0.1）`, '改为 127.0.0.1：本实验只允许本机回环');
    }
  }
}

// ───────────────────────────── 3. 数据库 ─────────────────────────────
console.log('\n── 事件库 ──');
const dbRel = readJsonSafe(manifestPath)?.db || 'demo-data/events.db';
const dbAbs = path.isAbsolute(dbRel) ? dbRel : path.join(REPO, dbRel);
record(
  '事件库文件',
  exists(dbAbs),
  exists(dbAbs) ? `${dbRel}（已存在，历史事件可查）` : `${dbRel}（尚不存在——首次采集时自动建库）`,
  exists(dbAbs) ? undefined : '无需手动建库；也可先跑 node bin\\trace.js init --db ' + dbRel,
);

// ───────────────────────────── 4. 客户端配置（只读检测）─────────────────────────────
console.log('\n── 客户端配置（仅检测，不修改）──');
const codexCfg = HOME ? path.join(HOME, '.codex', 'config.toml') : '';
let codexHasOurs = false;
if (codexCfg && exists(codexCfg)) {
  const t = fs.readFileSync(codexCfg, 'utf8');
  codexHasOurs = /mcp_servers\.(mail-trace|calendar-trace|mail|calendar)\b/.test(t);
  record('Codex 配置', true, `${codexCfg}${codexHasOurs ? '（已含本项目条目）' : '（尚未包含本项目条目）'}`);
  if (!codexHasOurs) console.log(`          → 见下方「配置片段 · Codex」；本命令不会替你写入`);
} else {
  record('Codex 配置', false, codexCfg ? `${codexCfg} 不存在` : '无法确定用户主目录', '安装并运行过一次 Codex 后会生成该文件');
}

const dshPatch = HOME ? path.join(HOME, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml') : '';
const dshBundleDir = path.join(REPO, 'dsh-bundle-mcp-trace');
if (dshPatch && exists(dshPatch)) {
  const t = fs.readFileSync(dshPatch, 'utf8');
  const flatInsert = /^\s*-\s*id:\s*mcp-trace/m.test(t) && !/^\s*-\s*insert:/m.test(t);
  record('DSH profile patch', true, dshPatch);
  if (flatInsert) {
    console.log(`${WARN} 该文件顶层直接写了 mcp-trace* 条目。若这些条目指向未安装的插件，会被**静默跳过**（不报错、不挂载、无工具）。`);
    console.log(`          → 正确做法：用插件管理器安装 ${dshBundleDir}（详见该目录 README.md），而不是在 profile patch 里直接 insert。`);
  }
} else {
  record('DSH profile patch', false, dshPatch ? `${dshPatch} 不存在` : '无法确定用户主目录', '安装并启动过一次 DeepSeek Harness 后会生成');
}
record(
  'DSH 适配 bundle',
  exists(dshBundleDir),
  exists(dshBundleDir) ? dshBundleDir + '（经插件管理器「添加插件」填此路径安装）' : '未找到 dsh-bundle-mcp-trace/',
  exists(dshBundleDir) ? undefined : '该目录是 DSH 接入的必需件，缺失时无法注册 mcp__* 工具',
);

// ───────────────────── 4.5 凭证治理（**只读**；不属于「就绪」计数）─────────────────────
// 说明：接入需要 OAuth 的真实应用（Google/飞书…）才需要令牌；因此这一项用 [注意] 呈现，
// 不参与「N/M 项就绪」与退出码——否则没打算接真实应用的用户会被误判为「环境未就绪」。
// 安全承诺：**只读**。不创建目录、不创建/修改令牌文件、不触发任何网络请求。
console.log('\n── 凭证治理（只读检测）──');
{
  const credentialsPath = defaultCredentialsPath(process.env, process.platform);
  const fromCredentialsModule = describeCredentialStatus({ store: credentialsPath });
  if (!fromCredentialsModule.exists) {
    console.log(`${WARN} 真实应用 OAuth 令牌：未找到（${credentialsPath}）`);
    console.log('          → 仅在接入需要 OAuth 的真实应用时才需要：node bin\\oauth-login.js --login');
    console.log('          → 先看用法与前置：node bin\\oauth-login.js --help');
  } else if (fromCredentialsModule.error) {
    console.log(`${WARN} 真实应用 OAuth 令牌：文件存在但不可用（${fromCredentialsModule.error}）`);
    console.log('          → 重新登录：node bin\\oauth-login.js --login');
  } else {
    const expiredText = fromCredentialsModule.expired ? '可能已过期' : '未过期';
    console.log(
      `${WARN} 真实应用 OAuth 令牌：已存在（${expiredText}；过期时间 ${
        fromCredentialsModule.expires_at_utc ?? '未知'
      }；有 refresh_token：${fromCredentialsModule.has_refresh_token ? '是' : '否'}）`,
    );
    console.log(`          → 查看状态：node bin\\oauth-login.js --status`);
    if (fromCredentialsModule.expired || !fromCredentialsModule.has_refresh_token) {
      console.log('          → 刷新或重新登录：node bin\\oauth-login.js --ensure-fresh');
    }
  }
  console.log('          （本检测只读：不创建/不修改任何令牌文件，也不访问网络）');
}

// ───────────────────────────── 5. 汇总与下一步 ─────────────────────────────
const bad = results.filter((r) => !r.ok);
console.log('\n── 汇总 ──');
console.log(`  ${results.length - bad.length}/${results.length} 项就绪` + (bad.length ? `，未就绪：${bad.map((b) => b.name).join('、')}` : ''));

console.log('\n── 下一步（照抄即可）──');
console.log('  1) 启动全部上游（一个进程 + 一份清单 + 一个 run id）：');
console.log('       node bin\\trace-manager.js');
console.log('  2) 自检（应看到每个上游 upstream_ready:true）：');
console.log('       node bin\\trace-manager.js --status');
console.log('  3) 看页面：');
console.log('       node bin\\web.js --db ' + dbRel);
console.log('  4) 跑完实验后核对：');
console.log('       node bin\\trace.js runs --db ' + dbRel);
console.log('       node bin\\trace.js timeline --run <你的 experimentRunId> --json --db ' + dbRel);

console.log('\n── 配置片段 · Codex（复制到 ~/.codex/config.toml 末尾；本命令不代写）──');
console.log(`[mcp_servers.mail-trace]
command = '${process.execPath.replace(/\\/g, '\\\\')}'
args = ['${path.join(REPO, 'bin', 'gateway.js').replace(/\\/g, '\\\\')}', '--upstream-command', '${process.execPath.replace(/\\/g, '\\\\')}', '--upstream-arg', 'src\\\\mock_servers\\\\mock_mail.js', '--upstream-app', 'mock-mail', '--gateway-id', 'gw-mail']
cwd = '${REPO.replace(/\\/g, '\\\\')}'

[mcp_servers.mail-trace.env]
TRACE_EXPERIMENT_RUN_ID = "exp_codex_run1"
TRACE_CLIENT_LABEL = "codex"
TRACE_DB = "${dbRel.replace(/\//g, '\\\\')}"`);
console.log('  （env 必须写进每个 server 块；只在外层 shell set 不保证传进子进程——这是 2026-10-03 实测的失败原因）');

console.log('\n── 配置片段 · DeepSeek Harness（用插件管理器安装 bundle，不要直接 insert）──');
console.log(`  侧栏「插件」→「添加插件」→ 填本地绝对路径：
       ${dshBundleDir}
  安装后重启 Harness；工具名形如 mcp__mail__read_latest_meeting_notice
  ⚠️ 该目录不可移动/删除：安装时会把绝对路径记进 profile 依赖`);

if (bad.length) {
  console.log('\n结论：存在未就绪项（退出码 3）。按上面的 → 逐条处理后重跑本命令。');
  process.exit(3);
}
console.log('\n结论：全部就绪（退出码 0）。');
