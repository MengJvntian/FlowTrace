#!/usr/bin/env node
/**
 * bin/wrap-config.js — 应用端配置生成器（t38）
 *
 * 解决的问题（用户原话：「我其实说的是应用端配置好麻烦」）：
 * 把「某个已有 MCP server 包进 Gateway」这件事，从「记住 `--upstream-command/--upstream-arg/--upstream-app`
 * 的写法 + 三个客户端各写一遍 + 自己核对绝对路径」，变成**一条命令**：
 *
 * ```bat
 * node bin\wrap-config.js --server-name mail --upstream-app mock-mail ^
 *   --upstream-command node --upstream-arg src/mock_servers/mock_mail.js --client all
 * ```
 *
 * 输出三段**可直接粘贴**的配置（Codex TOML / DSH patch / VS Code mcp.json），其中：
 *   - Node 可执行文件 = `process.execPath`（本机真实值，不硬编码）；
 *   - `bin/gateway.js` / `bin/trace-manager.js` / `dsh-bundle-mcp-trace` = 运行期相对仓库根解析 + 存在性校验；
 *   - **绝不出现 `<...>` 尖括号占位符**（本项目 `src/gateway/config.js` 的占位符守卫会拒绝这类值）；
 *     需要用户改的地方用**具名说明**（例如注释里写「此处填你的 run id，例如 exp_codex_run1」）。
 *   - **默认只打印**，一个字节都不写；要落盘必须显式 `--write <仓库内路径>`（写用户 `~/.codex`/`~/.dsh` 一律 exit 2）。
 *
 * 与 `bin/setup.js` 的分工（刻意不重叠）：
 *   - `setup`    = 环境自检 + 发现你**已有**的 agent 配置 → 生成清单/替换片段（还能 `--from-agent` 导入）；
 *   - `wrap-config`（本工具）= 给定**一个应用**，生成三个客户端的**包装配置**，路径全部现算。
 *
 * 退出码：0 成功 / 1 未捕获异常 / 2 用法或配置错误（含写用户路径）/ 3 找不到可包装的东西（如上游脚本不存在）。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根（bin/ 的上一层）。 */
export const REPO_ROOT = path.resolve(HERE, '..');
/** DSH 适配 bundle 目录名（需经插件管理器安装）。 */
export const BUNDLE_DIRNAME = 'dsh-bundle-mcp-trace';
/** 默认客户端清单。 */
export const CLIENTS = Object.freeze(['codex', 'dsh', 'vscode']);

/** @param {string} message */
function out(text) {
  process.stdout.write(`${text}\n`);
}
/** @param {string} message */
function log(message) {
  process.stderr.write(`${message}\n`);
}

/** @returns {string} */
export function usage() {
  return [
    '用法: node bin\\wrap-config.js --server-name <名> --upstream-app <应用名> --upstream-command <原始命令> [选项]',
    '',
    '作用：把**一个已有的 MCP server** 包进 Gateway，并直接产出三个客户端可粘贴的配置。',
    '      （与 setup 的分工：setup 负责环境自检/发现你现有配置；本工具负责「给定一个应用，生成包装配置」。）',
    '',
    '必需参数：',
    '  --server-name <名>          客户端里看到的服务名（工具名前缀用它；只允许字母数字与 _ -）',
    '  --upstream-app <应用名>     被包装的应用名（写进事件库的 upstream_app，便于血缘识别）',
    '  --upstream-command <命令>   原 MCP server 的启动命令（例如 node、npx、python、C:\\...\\node.exe）',
    '',
    '可重复参数：',
    '  --upstream-arg <参数>       原 MCP server 的参数（可重复；相对路径按 --cwd 解析）',
    '',
    '选项：',
    '  --cwd <目录>                原 MCP server 的工作目录（缺省 = 仓库根）',
    '  --experiment-run-id <id>    写进配置的 TRACE_EXPERIMENT_RUN_ID（缺省 exp_<server>_run1）',
    '  --client <codex|dsh|vscode|all>  只输出指定客户端（缺省 all）',
    '  --db <相对路径>             事件库路径（缺省 demo-data\\demo\\events.db）',
    '  --port <端口>               trace-manager 监听端口（缺省 8790；用于 HTTP 形态的说明）',
    '  --json                      机器可读输出（含三段配置 + 真实路径 + 说明）',
    '  --write <仓库内路径>        把包装配置写进**仓库内**文件（默认一个字节都不写）',
    '  --help                      本说明',
    '',
    '退出码：0 成功 / 1 未捕获异常 / 2 用法或配置错误 / 3 找不到可包装的东西',
    '',
    '安全：默认只打印；**绝不写** ~/.codex、~/.dsh 或任何用户路径（写用户路径一律 exit 2 + 说明）。',
    '      输出里没有 `<...>` 占位符——需要你改的值都以具名注释说明。',
  ].join('\n');
}

/** 参数解析（多值参数用数组）。 @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {string[]} */
  const errors = [];
  /** @type {Record<string, any>} */
  const options = {
    help: false,
    serverName: null,
    upstreamApp: null,
    upstreamCommand: null,
    upstreamArgs: [],
    cwd: null,
    runId: null,
    client: 'all',
    db: path.join('demo-data', 'demo', 'events.db'),
    port: 8790,
    json: false,
    writePath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    const name = eq > 0 ? token.slice(0, eq) : token;
    const inline = eq > 0 ? token.slice(eq + 1) : null;
    /** @returns {string | null} */
    const take = () => {
      if (inline !== null) return inline;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        errors.push(`${name} 缺少取值`);
        return null;
      }
      index += 1;
      return next;
    };
    switch (name) {
      case '--help':
        options.help = true;
        break;
      case '--server-name':
      case '--upstream-app':
      case '--upstream-command':
      case '--cwd':
      case '--experiment-run-id':
      case '--client':
      case '--db':
      case '--write': {
        const value = take();
        if (value === null) break;
        if (name === '--server-name') options.serverName = value;
        else if (name === '--upstream-app') options.upstreamApp = value;
        else if (name === '--upstream-command') options.upstreamCommand = value;
        else if (name === '--cwd') options.cwd = value;
        else if (name === '--experiment-run-id') options.runId = value;
        else if (name === '--client') options.client = value.toLowerCase();
        else if (name === '--db') options.db = value;
        else options.writePath = value;
        break;
      }
      case '--upstream-arg': {
        const value = take();
        if (value !== null) options.upstreamArgs.push(value);
        break;
      }
      case '--port': {
        const value = take();
        if (value === null) break;
        const port = Number(value);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) errors.push(`--port 需要 1..65535 的整数（当前 ${JSON.stringify(value)}）`);
        else options.port = port;
        break;
      }
      case '--json':
        options.json = true;
        break;
      default:
        errors.push(`未知参数：${token}（用 --help 查看用法）`);
        break;
    }
  }
  if (!options.help) {
    for (const [flag, value] of [
      ['--server-name', options.serverName],
      ['--upstream-app', options.upstreamApp],
      ['--upstream-command', options.upstreamCommand],
    ]) {
      if (typeof value !== 'string' || value === '') errors.push(`缺少必需参数 ${flag}`);
    }
    if (options.serverName && !/^[A-Za-z0-9_-]{1,32}$/.test(options.serverName)) {
      errors.push(`--server-name 只能用字母数字与 _ -（且 1..32 字符），当前 ${JSON.stringify(options.serverName)}`);
    }
    if (!['all', ...CLIENTS].includes(options.client)) {
      errors.push(`--client 只能是 codex | dsh | vscode | all（当前 ${JSON.stringify(options.client)}）`);
    }
    // 占位符守卫：与 src/gateway/config.js 同一取向——标识字段里不得出现 `<...>` 或未展开的 ${...}
    for (const [label, value] of [
      ['--server-name', options.serverName],
      ['--upstream-app', options.upstreamApp],
      ['--experiment-run-id', options.runId],
    ]) {
      if (typeof value === 'string' && (/[<>]/.test(value) || /\$\{[^}]+\}/.test(value))) {
        errors.push(`${label} 里不能出现尖括号或未展开的 \${...} 占位符（当前 ${JSON.stringify(value)}）：请填真实值`);
      }
    }
  }
  return { ok: errors.length === 0, options, errors };
}

/** 目标路径是否在仓库内（写盘守卫）。 @param {string} target */
export function isInsideRepo(target) {
  const resolved = path.resolve(target);
  const relative = path.relative(REPO_ROOT, resolved);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * 解析本机真实路径（不硬编码）。
 * @param {{repoRoot?: string, nodePath?: string, env?: Record<string, string | undefined>}} [input]
 */
export function resolvePaths(input = {}) {
  const repoRoot = input.repoRoot ?? REPO_ROOT;
  const bundleDir = path.join(repoRoot, BUNDLE_DIRNAME);
  const home = (input.env ?? process.env).USERPROFILE || (input.env ?? process.env).HOME || '';
  const appData = (input.env ?? process.env).APPDATA || (home ? path.join(home, 'AppData', 'Roaming') : '');
  return {
    node: input.nodePath ?? process.execPath,
    gateway: path.join(repoRoot, 'bin', 'gateway.js'),
    manager: path.join(repoRoot, 'bin', 'trace-manager.js'),
    repoRoot,
    bundleDir,
    bundleExists: fs.existsSync(bundleDir),
    codexConfig: home ? path.join(home, '.codex', 'config.toml') : '(无法确定用户目录)',
    dshPatch: home ? path.join(home, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml') : '(无法确定用户目录)',
    vscodeMcpJson: appData ? path.join(appData, 'Code', 'User', 'mcp.json') : '(无法确定 %APPDATA%)',
  };
}

/**
 * 包装 command/args（这就是「把应用包进 Gateway」的核心形态）。
 * @param {{node: string, gateway: string, upstreamCommand: string, upstreamArgs: string[],
 *   upstreamApp: string, gatewayId: string}} input
 */
export function wrapArgv(input) {
  return [
    input.gateway,
    '--upstream-command',
    input.upstreamCommand,
    ...input.upstreamArgs.flatMap((arg) => ['--upstream-arg', arg]),
    '--upstream-app',
    input.upstreamApp,
    '--gateway-id',
    input.gatewayId,
  ];
}

/**
 * 生成三个客户端的可粘贴配置。
 * @param {{serverName: string, upstreamApp: string, upstreamCommand: string, upstreamArgs: string[],
 *   cwd: string, runId: string, db: string, port: number, client: string,
 *   paths: Record<string, any>}} input
 */
export function buildConfigs(input) {
  const gatewayId = `gw-${input.serverName}`;
  const argv = wrapArgv({ ...input, gateway: input.paths.gateway, gatewayId });
  const node = input.paths.node;
  const dbWin = input.db.replace(/\//g, '\\');
  const env = {
    TRACE_EXPERIMENT_RUN_ID: input.runId,
    TRACE_CLIENT_LABEL: 'codex',
    TRACE_DB: dbWin,
  };
  // 参数里的相对路径按 cwd 解析（避免用户在别的目录启动时找不到文件）
  const argsForClient = [input.paths.gateway, ...argv.slice(1).map((value) => value)];
  const tomlArgs = argsForClient.map((arg) => `'${arg}'`).join(', ');

  const codex = [
    `[mcp_servers.${input.serverName}-trace]`,
    `command = '${node}'`,
    `args = [${tomlArgs}]`,
    `cwd = '${input.cwd}'`,
    'startup_timeout_sec = 120',
    '',
    `[mcp_servers.${input.serverName}-trace.env]`,
    `TRACE_EXPERIMENT_RUN_ID = "${env.TRACE_EXPERIMENT_RUN_ID}"   # 每次实验换成你自己的 run id（示例 exp_codex_run1）；必须与清单一致`,
    `TRACE_CLIENT_LABEL = "codex"`,
    // TOML 基本字符串里 `\` 是转义符：Windows 路径必须用字面量字符串（单引号），否则是语法错误
    `TRACE_DB = '${dbWin}'`,
  ].join('\n');

  const dshPatch = [
    `- id: mcp-trace-${input.serverName}`,
    `  name: '${'@deepseek-ai/dsh-mcp-client'}'`,
    '  config:',
    `    serverName: ${input.serverName}`,
    '    transport: stdio',
    `    command: '${node}'`,
    '    args:',
    ...argsForClient.map((arg) => `      - '${arg}'`),
    `    cwd: '${input.cwd}'`,
    '    env:',
    `      TRACE_EXPERIMENT_RUN_ID: '${input.runId}'`,
    `      TRACE_CLIENT_LABEL: 'deepseek_harness'`,
    `      TRACE_DB: '${dbWin}'`,
    '    failOnStartupError: true',
    '    toolCallTimeoutMs: 120000',
  ].join('\n');

  const dshBundle = [
    `# DSH 侧必须**先经插件管理器安装本仓库的 bundle**（页面：侧栏「插件」→「添加插件」→ 填路径）：`,
    `#   ${input.paths.bundleDir}`,
    `#   bundle 是否存在：${input.paths.bundleExists ? '是' : '否（缺失时无法注册 mcp__* 工具，请先 npm run install:local 或检查仓库）'}`,
    '# 安装后不要直接在 profile patch 顶层写 mcp-trace* 条目（会被静默跳过）；patch 要用 `- insert:` 形态：',
    '',
    `# ${input.paths.dshPatch}`,
    '- insert:',
    dshPatch.split('\n').map((line, index) => (index === 0 ? `  ${line}` : `  ${line}`)).join('\n'),
  ].join('\n');

  const vscodeServer = {
    type: 'stdio',
    command: node,
    args: argsForClient,
    cwd: input.cwd,
    env: { ...env, TRACE_CLIENT_LABEL: 'vscode' },
  };
  const vscodeJson = { servers: { [`${input.serverName}-trace`]: vscodeServer } };

  return {
    gatewayId,
    argv,
    codex: { file: input.paths.codexConfig, format: 'toml', snippet: codex, args: argsForClient, env },
    dsh: {
      file: input.paths.dshPatch,
      format: 'yaml',
      snippet: dshBundle,
      patch: dshPatch,
      args: argsForClient,
      env: { ...env, TRACE_CLIENT_LABEL: 'deepseek_harness' },
    },
    vscode: { file: input.paths.vscodeMcpJson, format: 'json', json: vscodeJson, snippet: JSON.stringify(vscodeJson, null, 2), args: argsForClient, env: vscodeServer.env },
  };
}

/** 三客户端差异说明（两处输出共用，避免两处描述不一致）。
 * @param {Record<string, any>} paths */
export function clientNotes(paths) {
  return [
    '三个客户端的差异（照抄，别混）：',
    `  1) Codex（${paths.codexConfig}）：TOML；server 块 + **独立 .env 子表**（mcp_servers.<名字>.env 形式——见片段里已经填好的真实名字），env 必须写在这里，只在外层 set 不保证传进子进程；工具名形如 mcp__ + 服务名 + __ + 工具名。`,
    `  2) DSH（${paths.dshPatch}）：**必须先用插件管理器安装 bundle**（${paths.bundleDir}），patch 用 \`- insert:\` 形态，服务名取自 config.serverName；工具名形如 mcp__ + 服务名 + __ + 工具名。`,
    `  3) VS Code（${paths.vscodeMcpJson}）：JSON 的 { "servers": { ... } } 形态；**工具名前缀由 VS Code 自己按服务名合成，与 DSH 的 mcp__ 前缀不是同一套，别互抄**（以 VS Code 工具列表里显示的为准）。`,
    '语言/编码：TOML 与 YAML 里的 Windows 路径用单引号（不转义）；DB 路径写成相对仓库根的形式，配合 cwd 使用。',
  ];
}

/** @param {Record<string, any>} result @param {Record<string, any>} paths */
function renderText(result, paths) {
  const lines = [];
  lines.push(`把「${result.upstream_app}」包进 Gateway —— 服务名 ${result.server_name}，gateway_id ${result.gateway_id}`);
  lines.push(`仓库根：${paths.repoRoot}`);
  lines.push(`Node：${paths.node}`);
  lines.push(`Gateway：${paths.gateway}（存在：${fs.existsSync(paths.gateway) ? '是' : '否'}）`);
  lines.push('');
  if (result.codex) {
    lines.push('── ① Codex：复制进 ' + result.codex.file + ' 末尾 ──');
    lines.push(result.codex.snippet);
    lines.push('');
  }
  if (result.dsh) {
    lines.push('── ② DSH：先装 bundle，再把下面这段合进 ' + result.dsh.file + ' ──');
    lines.push(result.dsh.snippet);
    lines.push('');
  }
  if (result.vscode) {
    lines.push('── ③ VS Code：把下面内容合并进 ' + result.vscode.file + ' ──');
    lines.push(result.vscode.snippet);
    lines.push('');
  }
  lines.push('── 说明 ──');
  for (const note of result.notes) lines.push(`  ${note}`);
  return lines.join('\n');
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.options.help) {
    out(usage());
    process.exit(0);
  }
  if (!parsed.ok) {
    for (const error of parsed.errors) log(`[wrap-config] 配置错误：${error}`);
    log(usage());
    process.exit(2);
  }
  const options = parsed.options;
  const paths = resolvePaths();
  const repoRoot = paths.repoRoot;
  const cwd = options.cwd ? (path.isAbsolute(options.cwd) ? options.cwd : path.join(repoRoot, options.cwd)) : repoRoot;

  // 可包装性检查：上游命令若是仓库内相对路径，必须真的存在（否则用户粘完才发现）
  if (options.upstreamArgs.includes('--help')) {
    log('[wrap-config] 提示：原 server 的 --help 会作为参数原样写进配置（本工具不执行上游）');
  }
  const firstScript = options.upstreamArgs.find((arg) => /\.(mjs|cjs|js|py)$/i.test(arg));
  if (firstScript) {
    const absolute = path.isAbsolute(firstScript) ? firstScript : path.join(cwd, firstScript);
    if (!fs.existsSync(absolute)) {
      log(`[wrap-config] 找不到可包装的上游脚本：${absolute}`);
      log('  → 确认路径（相对路径按 --cwd 解析）或先用 --cwd 指定上游所在目录');
      process.exit(3);
    }
  }

  const runId = options.runId ?? `exp_${options.serverName.replace(/[^A-Za-z0-9_]/g, '_')}_run1`;
  const configs = buildConfigs({
    serverName: options.serverName,
    upstreamApp: options.upstreamApp,
    upstreamCommand: options.upstreamCommand,
    upstreamArgs: options.upstreamArgs,
    cwd,
    runId,
    db: options.db,
    port: options.port,
    client: options.client,
    paths,
  });
  const wanted = options.client === 'all' ? CLIENTS : [options.client];
  /** @type {Record<string, any>} */
  const result = {
    ok: true,
    server_name: options.serverName,
    upstream_app: options.upstreamApp,
    gateway_id: configs.gatewayId,
    run_id: runId,
    paths: {
      node: paths.node,
      gateway: paths.gateway,
      manager: paths.manager,
      repo_root: paths.repoRoot,
      bundle_dir: paths.bundleDir,
      bundle_exists: paths.bundleExists,
      codex_config: paths.codexConfig,
      dsh_patch: paths.dshPatch,
      vscode_mcp_json: paths.vscodeMcpJson,
    },
    wrapped_argv: configs.argv,
    clients: {},
    notes: [
      ...clientNotes(paths),
      '与 setup 的分工：setup 负责环境自检 / 发现你现有配置（还能用 --from-agent 导入你现有的 agent 配置）；本工具负责「给定一个应用，生成三个客户端的包装配置」——两者不重叠、不互相抄。',
      `HTTP 形态（推荐：单进程多上游，一个 run id 覆盖全部）：先 node bin\\trace-manager.js（端口 ${options.port}），客户端 url 用 http://127.0.0.1:${options.port}/${options.serverName}/mcp`,
      '本工具默认只打印：要落盘请在 --write 后面跟一个**仓库内**路径（例如 demo-data/tmp/wrap-config.json）；写用户 ~/.codex、~/.dsh 一律拒绝。',
    ],
  };
  for (const client of wanted) result.clients[client] = configs[client];

  if (options.writePath) {
    const target = path.isAbsolute(options.writePath) ? options.writePath : path.join(repoRoot, options.writePath);
    if (!isInsideRepo(target)) {
      log(`[wrap-config] 拒绝写入仓库外的路径：${target}`);
      log('  → 请用 --write 指到仓库内（例如 demo-data/tmp/wrap-config.json）；用户配置请自行复制粘贴，本工具绝不代写');
      process.exit(2);
    }
    const payload = `${JSON.stringify(
      { server_name: result.server_name, upstream_app: result.upstream_app, clients: result.clients, paths: result.paths },
      null,
      2,
    )}\n`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, payload, 'utf8');
    log(`[wrap-config] 已写入 ${target}（${Buffer.byteLength(payload, 'utf8')} 字节）`);
  }

  if (options.json) out(JSON.stringify(result, null, 2));
  else {
    const text = renderText({ ...result, ...configs }, paths);
    out(text);
  }
  process.exit(0);
}

// 仅在被直接执行时运行（测试 import 无副作用）。
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((error) => {
    process.stderr.write(`[wrap-config] 未捕获异常：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
