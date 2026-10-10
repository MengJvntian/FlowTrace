/**
 * src/setup/import_agents.js — 只读导入用户现有 agent 配置 → Gateway 清单 + 替换片段（t33）
 *
 * 解决的问题：用户本来就已经给 agent 配好了 MCP（Codex `config.toml` / DSH `cordis.patch.yml`），
 * 却还要把这些 server 手抄一遍进 `trace.manifest.json`。本模块**只读**解析那份现有配置，
 * 逐字段保真地（**不解析 `${ENV}`、不改写值**）转成清单上游，并给出 agent 侧「改为指向 Gateway」的替换片段。
 *
 * 解析器是**最小子集**：只为这两种配置的实际形状服务（TOML 的 `[mcp_servers.*]` 与 YAML 的 `- insert:` 条目）。
 * 不引入 TOML/YAML 依赖；不认识的结构一律给可辨识错误，而不是猜。
 */
import path from 'node:path';
import process from 'node:process';

/** 支持的 agent 类型。 */
export const AGENT_KINDS = Object.freeze(['codex', 'dsh']);
/** DSH mcp-client 插件名（用于识别条目）。 */
export const DSH_CLIENT_NAME = '@deepseek-ai/dsh-mcp-client';
/** 默认上游 endpoint 后缀。 */
export const DEFAULT_ENDPOINT_SUFFIX = '/mcp';

/** 导入/转换错误（带可辨识 code）。 */
export class AgentImportError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message);
    this.name = 'AgentImportError';
    this.code = code;
  }
}

/**
 * 去掉行尾注释（尊重引号内的 `#`）。
 * @param {string} line
 */
function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) return line.slice(0, index);
  }
  return line;
}

/** @param {string} raw */
function parseScalar(raw) {
  const text = raw.trim();
  if (text === '') return '';
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    // TOML 字面量字符串：内部不转义（Windows 路径就靠这个）
    return text.slice(1, -1);
  }
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return text.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

/**
 * 解析数组字面量的元素：支持逗号分隔、换行/空格分隔、单/双引号与裸值。
 * @param {string} body 已去掉外层 `[` `]`
 * @returns {string[]}
 */
export function parseArrayItems(body) {
  /** @type {string[]} */
  const items = [];
  let index = 0;
  while (index < body.length) {
    const ch = body[index];
    if (ch === ',' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      index += 1;
      continue;
    }
    if (ch === "'") {
      const end = body.indexOf("'", index + 1);
      const stop = end === -1 ? body.length : end;
      items.push(body.slice(index + 1, stop));
      index = stop + 1;
      continue;
    }
    if (ch === '"') {
      let cursor = index + 1;
      let value = '';
      while (cursor < body.length) {
        if (body[cursor] === '\\' && cursor + 1 < body.length) {
          value += body[cursor + 1];
          cursor += 2;
          continue;
        }
        if (body[cursor] === '"') break;
        value += body[cursor];
        cursor += 1;
      }
      items.push(value);
      index = cursor + 1;
      continue;
    }
    let cursor = index;
    while (cursor < body.length && !',\n\r'.includes(body[cursor])) cursor += 1;
    const bare = body.slice(index, cursor).trim();
    if (bare !== '') items.push(bare);
    index = cursor;
  }
  return items;
}

/**
 * 解析**最小子集** TOML：表头 + `key = value`，值支持字符串/数组/布尔/数字。
 * @param {string} text
 * @returns {{tables: Map<string, Record<string, any>>, warnings: string[]}}
 */
export function parseTomlSubset(text) {
  /** @type {Map<string, Record<string, any>>} */
  const tables = new Map();
  const warnings = [];
  let current = '';
  tables.set('', {});
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripComment(lines[index]).trim();
    if (line === '') continue;
    const tableMatch = /^\[([^\]]+)\]$/.exec(line);
    if (tableMatch) {
      current = tableMatch[1].trim();
      if (!tables.has(current)) tables.set(current, {});
      continue;
    }
    const assignMatch = /^([A-Za-z0-9_.\-"']+)\s*=\s*(.*)$/.exec(line);
    if (!assignMatch) {
      warnings.push(`第 ${index + 1} 行不是认识的形式，已跳过：${line.slice(0, 80)}`);
      continue;
    }
    const key = parseScalar(assignMatch[1]);
    let rawValue = assignMatch[2].trim();
    // 多行数组：一直读到括号配平
    if (rawValue.startsWith('[') && !rawValue.includes(']')) {
      let depth = 1;
      while (depth > 0 && index + 1 < lines.length) {
        index += 1;
        const next = stripComment(lines[index]);
        for (const ch of next) {
          if (ch === '[') depth += 1;
          else if (ch === ']') depth -= 1;
        }
        rawValue += ` ${next.trim()}`;
      }
    }
    const table = tables.get(current);
    if (rawValue.startsWith('[')) {
      const inner = rawValue.replace(/^\[/, '').replace(/\]$/, '');
      table[key] = parseArrayItems(inner);
      continue;
    }
    table[key] = parseScalar(rawValue);
  }
  return { tables, warnings };
}

/**
 * 从 Codex `config.toml` 文本提取 server 定义（**原样**保留 command/args/cwd/env）。
 * @param {string} text
 * @returns {{servers: Array<Record<string, any>>, warnings: string[]}}
 */
export function parseCodexConfig(text) {
  const { tables, warnings } = parseTomlSubset(text);
  /** @type {Array<Record<string, any>>} */
  const servers = [];
  for (const [tableName, table] of tables.entries()) {
    const match = /^mcp_servers\.([^.]+)$/.exec(tableName);
    if (!match) continue;
    const rawName = match[1];
    /** @type {Record<string, any>} */
    const server = { raw_name: rawName, agent: 'codex' };
    if (typeof table.command === 'string') server.command = table.command;
    if (Array.isArray(table.args)) server.args = table.args.map((item) => String(item));
    if (typeof table.cwd === 'string') server.cwd = table.cwd;
    if (typeof table.url === 'string') server.url = table.url;
    if (table.headers && typeof table.headers === 'object' && !Array.isArray(table.headers)) server.headers = { ...table.headers };
    if (Array.isArray(table.env_vars)) server.env_vars = table.env_vars.map((item) => String(item));
    if (table.enabled !== undefined) server.enabled = table.enabled;
    if (table.startup_timeout_sec !== undefined) server.startup_timeout_sec = table.startup_timeout_sec;
    const envTable = tables.get(`mcp_servers.${rawName}.env`);
    if (envTable && Object.keys(envTable).length > 0) server.env = { ...envTable };
    server.transport = server.url ? 'streamable-http' : 'stdio';
    if (!server.command && !server.url) {
      throw new AgentImportError(
        `[mcp_servers.${rawName}] 既没有 command 也没有 url：无法判断启动方式（缺必需字段）`,
        'missing_required_field',
      );
    }
    servers.push(server);
  }
  return { servers, warnings };
}

/**
 * 解析**最小子集** YAML（缩进 + `- ` 列表 + `key: value` + 内联数组）。
 * 导出仅为可测性（测试可直接断言结构，而不只看最终结果）。
 * @param {string} text
 * @returns {any}
 */
export function parseYamlSubset(text) {
  /** @type {Array<{indent: number, content: string, lineNo: number}>} */
  const lines = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const noComment = stripComment(raw);
    if (noComment.trim() === '') return;
    const indent = noComment.match(/^\s*/)?.[0].replace(/\t/g, '  ').length ?? 0;
    lines.push({ indent, content: noComment.trim(), lineNo: index + 1 });
  });

  let cursor = 0;
  /** @param {number} indent */
  function parseBlock(indent) {
    if (cursor >= lines.length) return null;
    const first = lines[cursor];
    if (first.indent < indent) return null;
    if (first.content.startsWith('-')) {
      /** @type {any[]} */
      const array = [];
      while (cursor < lines.length && lines[cursor].indent === indent && lines[cursor].content.startsWith('-')) {
        const itemText = lines[cursor].content.slice(1).trim();
        cursor += 1;
        if (itemText === '') {
          const childIndent = cursor < lines.length ? lines[cursor].indent : indent + 1;
          array.push(cursor < lines.length && childIndent > indent ? parseBlock(childIndent) : null);
          continue;
        }
        // 只有「看起来真的是键」的条目才当映射解析：键必须是纯标识符（不含引号/反斜杠/冒号）。
        // 否则 Windows 路径（`- 'C:\probe\...'`）会被误判成 `C:` 键 —— t33 实测踩过。
        const inline = /^([A-Za-z0-9_@.\-]+):(\s.*|\s*)$/.exec(itemText);
        if (inline) {
          /** @type {Record<string, any>} */
          const object = {};
          const key = inline[1].trim().replace(/^['"]|['"]$/g, '');
          if (inline[2] === '') {
            const childIndent = cursor < lines.length ? lines[cursor].indent : indent + 1;
            object[key] = cursor < lines.length && childIndent > indent ? parseBlock(childIndent) : null;
          } else {
            object[key] = parseYamlScalar(inline[2]);
          }
          // 同一条目的后续键/子块：缩进 > indent、且不是同级的新 `- ` 条目
          // 注意：**不能**先 cursor+=1 再交给 parseMapping（那会吞掉一行 —— t33 实测踩过）。
          while (cursor < lines.length && lines[cursor].indent > indent && !lines[cursor].content.startsWith('- ')) {
            const before = cursor;
            parseMappingInto(lines[cursor].indent, object);
            if (cursor === before) cursor += 1; // 防死循环：没消费任何东西就强制前进
          }
          array.push(object);
        } else {
          array.push(parseYamlScalar(itemText));
        }
      }
      return array;
    }
    return parseMappingInto(indent, {});
  }

  /**
   * 把 `indent` 处的 `key: value` 键值对写进 target（值可为更深缩进的子块）。
   * @param {number} indent @param {Record<string, any>} target
   */
  function parseMappingInto(indent, target) {
    while (cursor < lines.length && lines[cursor].indent === indent && !lines[cursor].content.startsWith('-')) {
      const { content } = lines[cursor];
      cursor += 1;
      const match = /^([^:]+):\s*(.*)$/.exec(content);
      if (!match) continue;
      const key = match[1].trim().replace(/^['"]|['"]$/g, '');
      const rest = match[2];
      if (rest === '') {
        const childIndent = cursor < lines.length ? lines[cursor].indent : indent + 1;
        target[key] = cursor < lines.length && childIndent > indent ? parseBlock(childIndent) : null;
      } else {
        target[key] = parseYamlScalar(rest);
      }
    }
    return target;
  }

  const parsed = parseBlock(0);
  return parsed;
}

/** @param {string} raw */
function parseYamlScalar(raw) {
  return parseScalar(raw);
}

/**
 * 从 DSH `cordis.patch.yml` 文本提取 server 定义（支持顶层条目与 `- insert:` 两种形状）。
 * @param {string} text
 * @returns {{servers: Array<Record<string, any>>, warnings: string[]}}
 */
export function parseDshPatch(text) {
  const parsed = parseYamlSubset(text);
  if (!Array.isArray(parsed)) {
    throw new AgentImportError('cordis.patch.yml 顶层不是数组（该文件应为「顶层 YAML 数组」）', 'unrecognized_format');
  }
  /** @type {Array<Record<string, any>>} */
  const candidates = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item.insert)) {
      for (const nested of item.insert) if (nested && typeof nested === 'object') candidates.push(nested);
    } else {
      candidates.push(item);
    }
  }
  /** @type {Array<Record<string, any>>} */
  const servers = [];
  const warnings = [];
  for (const entry of candidates) {
    if (entry.name !== DSH_CLIENT_NAME) continue;
    const config = entry.config && typeof entry.config === 'object' ? entry.config : null;
    if (!config) {
      warnings.push(`条目 ${entry.id ?? '(无 id)'} 没有 config，已跳过`);
      continue;
    }
    /** @type {Record<string, any>} */
    const server = { raw_name: String(config.serverName ?? entry.id ?? ''), agent: 'dsh', entry_id: entry.id ?? null };
    const transport = config.transport ?? 'stdio';
    if (transport !== 'stdio' && transport !== 'streamable-http') {
      throw new AgentImportError(
        `条目 ${entry.id ?? server.raw_name} 的 transport=${JSON.stringify(transport)} 不支持（只支持 stdio / streamable-http）`,
        'unsupported_transport',
      );
    }
    server.transport = transport;
    if (typeof config.command === 'string') server.command = config.command;
    if (Array.isArray(config.args)) server.args = config.args.map((item) => String(item));
    if (typeof config.cwd === 'string') server.cwd = config.cwd;
    if (config.env && typeof config.env === 'object' && !Array.isArray(config.env)) server.env = { ...config.env };
    if (Array.isArray(config.env_vars)) server.env_vars = config.env_vars.map((item) => String(item));
    if (typeof config.url === 'string') server.url = config.url;
    if (config.headers && typeof config.headers === 'object' && !Array.isArray(config.headers)) server.headers = { ...config.headers };
    if (config.toolCallTimeoutMs !== undefined) server.toolCallTimeoutMs = config.toolCallTimeoutMs;
    if (!server.raw_name) throw new AgentImportError('条目缺少 serverName（DSH 必填）', 'missing_required_field');
    if (transport === 'stdio' && !server.command) {
      throw new AgentImportError(`条目 ${server.raw_name} 是 stdio 但没有 command（缺必需字段）`, 'missing_required_field');
    }
    if (transport === 'streamable-http' && !server.url) {
      throw new AgentImportError(`条目 ${server.raw_name} 是 streamable-http 但没有 url（缺必需字段）`, 'missing_required_field');
    }
    servers.push(server);
  }
  return { servers, warnings };
}

/** 默认的 agent 配置文件位置（只读）。 @param {string} kind @param {Record<string,string|undefined>} [env] */
export function defaultAgentConfigPath(kind, env = process.env) {
  const home = env.USERPROFILE || env.HOME || '';
  if (kind === 'codex') return path.join(home, '.codex', 'config.toml');
  if (kind === 'dsh') return path.join(home, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
  throw new AgentImportError(`不认识的 agent 类型：${kind}（只支持 codex / dsh）`, 'unknown_agent');
}

/** 由文件名/内容推断 agent 类型。 @param {string} filePath @param {string} text */
export function inferAgentKind(filePath, text) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.toml')) return 'codex';
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'dsh';
  if (/^\s*\[mcp_servers\./m.test(text)) return 'codex';
  if (/dsh-mcp-client|^-\s*id:|insert:/m.test(text)) return 'dsh';
  throw new AgentImportError(
    `无法从 ${path.basename(filePath)} 判断是 Codex（TOML）还是 DSH（YAML）配置：请显式用 --from-agent codex|dsh`,
    'unrecognized_format',
  );
}

/**
 * serverName 规范化（DSH 侧约束 `[A-Za-z0-9_-]{1,32}`）。
 * @param {string} raw
 */
export function sanitizeServerName(raw) {
  const cleaned = String(raw ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 32);
  return cleaned === '' ? 'app' : cleaned;
}

/**
 * 把 agent server 定义转成清单上游（**逐字段保真**；`${ENV}` 不解析）。
 *
 * @param {Array<Record<string, any>>} servers
 * @param {{port?: number, endpointSuffix?: string, usedNames?: Set<string>, usedPaths?: Set<string>}} [options]
 * @returns {{upstreams: Array<Record<string, any>>, warnings: string[], duplicates: Record<string, string>}}
 */
export function convertServersToUpstreams(servers, options = {}) {
  const usedNames = options.usedNames ?? new Set();
  const usedPaths = options.usedPaths ?? new Set();
  const endpointSuffix = options.endpointSuffix ?? DEFAULT_ENDPOINT_SUFFIX;
  /** @type {Array<Record<string, any>>} */
  const upstreams = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {Record<string, string>} */
  const duplicates = {};

  for (const server of servers) {
    let serverName = sanitizeServerName(server.raw_name);
    if (usedNames.has(serverName)) {
      // 自动去重（并说明），因为「同一个 agent 里两个 server 重名」在两种配置里都可能出现
      let candidate = serverName;
      let counter = 2;
      while (usedNames.has(candidate)) {
        const suffix = `-${counter}`;
        candidate = `${serverName.slice(0, 32 - suffix.length)}${suffix}`;
        counter += 1;
      }
      duplicates[server.raw_name] = candidate;
      warnings.push(
        `serverName ${JSON.stringify(server.raw_name)} 与已有条目冲突：已自动改用 ${JSON.stringify(candidate)}（如需保留原名，请在 agent 配置里改名）`,
      );
      serverName = candidate;
    }
    usedNames.add(serverName);

    let routePath = `/${serverName}${endpointSuffix}`;
    if (usedPaths.has(routePath)) {
      throw new AgentImportError(
        `路径 ${routePath} 与已有条目冲突：请给其中一个 server 换一个 serverName（建议加应用前缀，例如 ${serverName}-2）`,
        'duplicate_path',
      );
    }
    usedPaths.add(routePath);

    /** @type {Record<string, any>} */
    const upstream = {
      serverName,
      upstreamApp: serverName,
      gatewayId: `gw-${serverName}`,
      transport: server.transport,
      path: routePath,
    };
    if (server.transport === 'stdio') {
      // 保真：command/args/cwd/env 原样（`${ENV}` 一律不解析、不改写）
      upstream.command = server.command;
      upstream.args = Array.isArray(server.args) ? [...server.args] : [];
      if (server.cwd !== undefined) upstream.cwd = server.cwd;
      if (server.env !== undefined) upstream.env = { ...server.env };
      if (server.env_vars !== undefined) upstream.env_vars = [...server.env_vars];
    } else {
      upstream.url = server.url;
      if (server.headers !== undefined) upstream.headers = { ...server.headers };
    }
    if (server.toolCallTimeoutMs !== undefined) upstream.timeoutMs = Number(server.toolCallTimeoutMs) || undefined;
    upstreams.push(upstream);
  }
  return { upstreams, warnings, duplicates };
}

/**
 * 生成 agent 侧替换片段（同一批 server 改为指向 Gateway）。
 *
 * @param {Array<Record<string, any>>} upstreams
 * @param {{agent: 'codex'|'dsh', port: number, repoRoot: string, nodePath: string,
 *   manifestDb?: string, manifestRunId?: string}} input
 * @returns {{stdioToml: string, stdioYaml: string, httpYaml: string, httpToml: string, guidance: string[]}}
 */
export function buildReplacementSnippets(upstreams, input) {
  const node = input.nodePath;
  const gateway = path.join(input.repoRoot, 'bin', 'gateway.js');
  const linesToml = [];
  const linesYaml = [];
  const httpYaml = [];
  const httpToml = [];
  for (const upstream of upstreams) {
    const name = upstream.serverName;
    linesToml.push(`[mcp_servers.${name}-trace]
command = '${node}'
args = ['${gateway}', '--upstream-command', '${upstream.command ?? ''}', ${(upstream.args ?? [])
      .map((arg) => `'${arg}'`)
      .join(', ')}${(upstream.args ?? []).length ? ', ' : ''}'--upstream-app', '${upstream.upstreamApp}', '--gateway-id', '${upstream.gatewayId}']
cwd = '${input.repoRoot}'`);
    linesYaml.push(
      `- id: mcp-trace-${name}
  name: '${DSH_CLIENT_NAME}'
  config:
    serverName: ${name}
    transport: stdio
    command: '${node}'
    args:
      - '${gateway}'
      - '--upstream-command'
      - '${upstream.command ?? ''}'
${(upstream.args ?? []).map((arg) => `      - '${arg}'`).join('\n')}${(upstream.args ?? []).length ? '\n' : ''}      - '--upstream-app'
      - '${upstream.upstreamApp}'
      - '--gateway-id'
      - '${upstream.gatewayId}'
    cwd: '${input.repoRoot}'`,
    );
    const url = `http://127.0.0.1:${input.port}${upstream.path}`;
    httpYaml.push(`- id: mcp-trace-${name}
  name: '${DSH_CLIENT_NAME}'
  config:
    serverName: ${name}
    transport: streamable-http
    url: ${url}
    failOnStartupError: true
    toolCallTimeoutMs: 120000`);
    httpToml.push(`[mcp_servers.${name}-trace]
# Codex 侧只能走 stdio（--url 形式未验证）；若你只用 trace-manager，请用上面的 DSH/HTTP 形态或继续用 gateway.js 形态`);
  }
  return {
    stdioToml: linesToml.join('\n\n'),
    stdioYaml: linesYaml.join('\n\n'),
    httpYaml: httpYaml.join('\n\n'),
    httpToml: httpToml.join('\n\n'),
    guidance: [
      '① 先把上面的 Gateway 上游清单确认无误（默认只打印，不改你的任何配置文件）；',
      `② 再启动 Gateway 侧：node bin\\trace-manager.js（单进程多上游，一个 run id 覆盖全部上游；端口 ${input.port}）`,
      '③ 然后把「agent 侧替换片段」粘贴进你的 agent 配置，**替换**原来的同类条目（同一 serverName 只留一份）；',
      '④ 最后自检：node bin\\trace-manager.js --status（未就绪会给出原因）',
      input.agent === 'codex'
        ? '（Codex 的 config.toml 需要你手动编辑：本命令绝不改写 ~/.codex/**）'
        : '（DSH 建议用插件管理器安装 bundle；本命令绝不改写 ~/.dsh/**）',
    ],
  };
}

/**
 * 端到端：从文件（或给定文本）导入 → { servers, upstreams, manifest, snippets }。
 *
 * @param {{kind?: 'codex'|'dsh', filePath?: string, text?: string, runId?: string, clientLabel?: string,
 *   port?: number, repoRoot: string, nodePath: string, db?: string}} input
 */
export function importAgentConfig(input) {
  let text = input.text;
  let filePath = input.filePath ?? null;
  const kind = input.kind ?? (filePath ? inferAgentKind(filePath, text ?? '') : null);
  if (text === undefined && filePath) {
    const fs = input.fs ?? null;
    if (!fs) throw new AgentImportError('缺少 fs', 'internal');
    text = fs.readFileSync(filePath, 'utf8');
  }
  if (typeof text !== 'string') throw new AgentImportError('没有可导入的内容（既没给文件也没给文本）', 'no_input');
  const effectiveKind = kind ?? inferAgentKind(filePath ?? 'agent-config', text);
  const parsed = effectiveKind === 'codex' ? parseCodexConfig(text) : parseDshPatch(text);
  if (parsed.servers.length === 0) {
    throw new AgentImportError(
      effectiveKind === 'codex'
        ? '在 config.toml 里没有找到任何 [mcp_servers.*] 条目（无法生成清单）'
        : `在 cordis.patch.yml 里没有找到任何 name=${DSH_CLIENT_NAME} 的条目（无法生成清单）`,
      'no_servers_found',
    );
  }
  const { upstreams, warnings, duplicates } = convertServersToUpstreams(parsed.servers, { port: input.port });
  const runId = input.runId ?? `exp_${effectiveKind}_import_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  const manifest = {
    version: 1,
    _readme: `由 node bin/setup.js --from-agent ${effectiveKind} 生成（只读导入你现有 agent 配置）。`,
    _generated_from: filePath ?? `(inline ${effectiveKind} text)`,
    _generated_at_utc: new Date().toISOString(),
    experimentRunId: runId,
    clientLabel: input.clientLabel ?? (effectiveKind === 'codex' ? 'codex' : 'deepseek_harness'),
    db: input.db ?? 'demo-data/demo/events.db',
    http: { host: '127.0.0.1', port: input.port ?? 8790 },
    upstreams,
  };
  const snippets = buildReplacementSnippets(upstreams, {
    agent: effectiveKind,
    port: input.port ?? 8790,
    repoRoot: input.repoRoot,
    nodePath: input.nodePath,
    manifestRunId: runId,
  });
  return {
    kind: effectiveKind,
    filePath,
    servers: parsed.servers,
    upstreams,
    manifest,
    snippets,
    warnings: [...(parsed.warnings ?? []), ...warnings],
    duplicates,
  };
}
