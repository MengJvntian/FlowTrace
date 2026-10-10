/**
 * src/gateway/manifest.js — 实验清单（`trace.manifest.json`）加载与校验（t29）
 *
 * 为什么有它：以前装配一次真实实验要「开 N 个终端 + 手写 N 条长命令 + 人工保证
 * `--experiment-run-id` 一致」。人工对齐**真的失败过**：Mail 读与 Calendar 写落到两个 run id 的
 * 两个运行里，P2 字段级血缘直接做不出来。清单把「全部上游 + 本次实验的 run id/client label + 库路径」
 * 收进**一份唯一真源**，于是 `bin/trace-manager.js` 一次启动全部上游时，
 * **一个 `experimentRunId` 天然覆盖所有上游**——参数漂移从设计上不可能发生。
 *
 * 清单里的「密钥」处理（硬要求：令牌绝不入库、绝不进日志）：
 *   - 任何字符串里的环境变量引用（写 `$` 加 `{VAR}`）都从环境变量取值；
 *   - **未设置该环境变量 = 配置错误**（不静默用空串，否则会拿着空令牌去连远端，错误信息还很难懂）；
 *   - 解析过的字段会带上 `containsEnvRef` 标记，`upstreamDescriptor()` 据此把「引用了环境变量的部分」
 *     一律写成 `<redacted>`；HTTP 头的**值在任何情况下都不写进事件**（只写头名）。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { DEFAULT_DB_PATH, DEFAULT_TIMEOUT_MS, assertNoPlaceholders } from './config.js';
import { collectOAuthRefs, parseOAuthProviders, substituteOAuthRefs } from '../credentials/provider.js';

/** 清单格式版本（结构变化时递增）。 */
export const MANIFEST_VERSION = 1;
/** 默认清单路径（仓库根）。 */
export const DEFAULT_MANIFEST_PATH = 'trace.manifest.json';
/** 默认监听端口（与 bin/gateway-http.js 的 8787 区分开，避免与单上游入口撞端口）。 */
export const DEFAULT_HTTP_PORT = 8790;
/** 只允许绑回环地址。 */
export const DEFAULT_HTTP_HOST = '127.0.0.1';
/** serverName 命名规则（与 DSH mcp-client 的约束一致）。 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * 解析 `${ENV_NAME}` 引用。
 * @param {unknown} value
 * @param {Record<string, string | undefined>} env
 * @param {{errors: string[], where: string}} context
 * @returns {{value: unknown, containsEnvRef: boolean, envNames: string[]}}
 */
export function resolveTemplate(value, env, context) {
  if (typeof value !== 'string') return { value, containsEnvRef: false, envNames: [] };
  /** @type {string[]} */
  const envNames = [];
  let missing = false;
  const resolved = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
    envNames.push(name);
    const raw = env[name];
    if (raw === undefined || raw === '') {
      context.errors.push(`${context.where} 引用的环境变量 ${name} 未设置或为空（拒绝用空串继续，避免拿空令牌去连远端）`);
      missing = true;
      return '';
    }
    return raw;
  });
  return { value: missing ? '' : resolved, containsEnvRef: envNames.length > 0, envNames };
}

/**
 * 读取 + 校验清单。
 * @param {{manifestPath?: string, env?: Record<string, string | undefined>, cwd?: string}} [options]
 * @returns {{ok: boolean, manifest: Record<string, any> | null, errors: string[], warnings: string[], path: string}}
 */
export function loadManifest(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
  const absolute = path.isAbsolute(manifestPath) ? manifestPath : path.resolve(cwd, manifestPath);
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  let raw;
  try {
    raw = options.manifestText ?? fs.readFileSync(absolute, 'utf8');
  } catch (error) {
    return {
      ok: false,
      manifest: null,
      errors: [`无法读取清单 ${absolute}：${error instanceof Error ? error.message : String(error)}`],
      warnings,
      path: absolute,
    };
  }
  /** @type {Record<string, any>} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      manifest: null,
      errors: [`清单不是合法 JSON（${absolute}）：${error instanceof Error ? error.message : String(error)}`],
      warnings,
      path: absolute,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, manifest: null, errors: [`清单顶层必须是对象：${absolute}`], warnings, path: absolute };
  }

  if (parsed.version !== undefined && Number(parsed.version) !== MANIFEST_VERSION) {
    warnings.push(`清单 version=${JSON.stringify(parsed.version)}，本实现按 version=${MANIFEST_VERSION} 解析（未知键会被忽略）`);
  }

  // ── t35：令牌提供者（`headers` 里的 `${oauth:<名字>}` 引用必须在静态校验期就能对上号）──
  const oauthProviders = parseOAuthProviders(parsed.oauthProviders, {
    env,
    repoRoot: path.resolve(cwd),
    where: 'oauthProviders',
    errors,
    resolveTemplate,
  });

  // ── 本次实验（唯一真源：一个 run id 覆盖全部上游）────────────────────────────
  const runIdTemplate = resolveTemplate(parsed.experimentRunId, env, { errors, where: 'experimentRunId' });
  const experimentRunId = runIdTemplate.value;
  if (typeof experimentRunId !== 'string' || experimentRunId.trim() === '') {
    errors.push('清单缺少 experimentRunId（本次实验的运行 ID；一个 run id 会覆盖清单里全部上游）');
  }
  const clientLabelTemplate = resolveTemplate(parsed.clientLabel, env, { errors, where: 'clientLabel' });
  const clientLabel = clientLabelTemplate.value;
  if (typeof clientLabel !== 'string' || clientLabel.trim() === '') {
    errors.push('清单缺少 clientLabel（deterministic | codex | deepseek_harness）');
  }
  const dbTemplate = resolveTemplate(parsed.db ?? DEFAULT_DB_PATH, env, { errors, where: 'db' });
  const dbPath = dbTemplate.value;
  if (typeof dbPath !== 'string' || dbPath.trim() === '') errors.push('清单的 db 不是有效字符串');

  const httpSource = parsed.http ?? {};
  const host = httpSource.host ?? DEFAULT_HTTP_HOST;
  if (host !== DEFAULT_HTTP_HOST) {
    errors.push(`http.host 只能是 ${DEFAULT_HTTP_HOST}（本实验只允许本机回环，不接受 ${JSON.stringify(host)}）`);
  }
  const portRaw = httpSource.port ?? DEFAULT_HTTP_PORT;
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    errors.push(`http.port 需要 0..65535 的整数（0 = 任意空闲端口；当前 ${JSON.stringify(portRaw)}）`);
  }

  // ── 上游列表 ───────────────────────────────────────────────────────────────
  const upstreamsSource = Array.isArray(parsed.upstreams) ? parsed.upstreams : null;
  if (!upstreamsSource || upstreamsSource.length === 0) {
    errors.push('清单缺少 upstreams（至少一个上游）');
  }
  /** @type {Array<Record<string, any>>} */
  const upstreams = [];
  /** @type {Map<string, string>} */
  const usedPaths = new Map();
  const seenNames = new Set();
  const seenGatewayIds = new Set();

  for (const [index, item] of (upstreamsSource ?? []).entries()) {
    const where = `upstreams[${index}]`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${where} 必须是对象`);
      continue;
    }
    const serverName = item.serverName;
    if (typeof serverName !== 'string' || !SERVER_NAME_PATTERN.test(serverName)) {
      errors.push(`${where}.serverName 必须匹配 ${SERVER_NAME_PATTERN}（当前 ${JSON.stringify(serverName)}）`);
      continue;
    }
    if (seenNames.has(serverName)) {
      errors.push(`${where}.serverName=${serverName} 重复（serverName 在一个清单内必须唯一）`);
      continue;
    }
    seenNames.add(serverName);

    const upstreamAppRaw = resolveTemplate(item.upstreamApp, env, { errors, where: `${where}.upstreamApp` });
    const upstreamApp = upstreamAppRaw.value ?? serverName;
    if (typeof upstreamApp !== 'string' || upstreamApp.trim() === '') {
      errors.push(`${where}.upstreamApp 不是有效字符串`);
      continue;
    }
    const gatewayIdRaw = resolveTemplate(item.gatewayId ?? `gw_${upstreamApp}`, env, { errors, where: `${where}.gatewayId` });
    const gatewayId = gatewayIdRaw.value;
    if (typeof gatewayId !== 'string' || gatewayId.trim() === '') {
      errors.push(`${where}.gatewayId 不是有效字符串`);
      continue;
    }
    if (seenGatewayIds.has(gatewayId)) {
      errors.push(`${where}.gatewayId=${gatewayId} 重复（同一库里的 gateway_id 必须唯一，否则无法区分来源）`);
      continue;
    }
    seenGatewayIds.add(gatewayId);

    const pathRaw = item.path ?? `/${serverName}/mcp`;
    const routePath = typeof pathRaw === 'string' && pathRaw.startsWith('/') ? pathRaw : `/${String(pathRaw)}`;
    if (usedPaths.has(routePath)) {
      errors.push(`${where}.path=${routePath} 与 ${usedPaths.get(routePath)} 冲突（同一端口必须一个路径一个上游）`);
      continue;
    }
    usedPaths.set(routePath, serverName);

    const transport = item.transport ?? 'stdio';
    if (transport !== 'stdio' && transport !== 'streamable-http') {
      errors.push(`${where}.transport 只能是 stdio 或 streamable-http（当前 ${JSON.stringify(transport)}）`);
      continue;
    }
    const timeoutRaw = item.timeoutMs ?? parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeoutMs = Number(timeoutRaw);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      errors.push(`${where}.timeoutMs 需要正整数（当前 ${JSON.stringify(timeoutRaw)}）`);
      continue;
    }

    /** @type {Record<string, any>} */
    const entry = {
      serverName,
      upstreamApp,
      gatewayId,
      path: routePath,
      transport,
      timeoutMs,
      clientLabel,
      experimentRunId,
      dbPath,
      containsEnvRef: upstreamAppRaw.containsEnvRef || gatewayIdRaw.containsEnvRef,
    };

    if (transport === 'stdio') {
      // 说明：`command` 缺省用**当前 node**（`process.execPath`）。直接写 "node" 也解析成当前 node，
      // 避免 PATH 上的系统 Node（22）不支持 node:sqlite 时出现难懂的失败。
      const commandRaw = resolveTemplate(item.command ?? 'node', env, { errors, where: `${where}.command` });
      let command = commandRaw.value;
      if (typeof command !== 'string' || command.trim() === '') {
        errors.push(`${where}.command 不是有效字符串`);
        continue;
      }
      if (command === 'node' || command === 'node.exe') command = process.execPath;
      const argsRaw = Array.isArray(item.args) ? item.args : [];
      /** @type {string[]} */
      const args = [];
      for (const [argIndex, arg] of argsRaw.entries()) {
        const resolved = resolveTemplate(arg, env, { errors, where: `${where}.args[${argIndex}]` });
        if (typeof resolved.value !== 'string') {
          errors.push(`${where}.args[${argIndex}] 必须是字符串`);
          continue;
        }
        args.push(resolved.value);
        entry.containsEnvRef = entry.containsEnvRef || resolved.containsEnvRef;
      }
      const cwdRaw = resolveTemplate(item.cwd ?? null, env, { errors, where: `${where}.cwd` });
      entry.command = command;
      entry.args = args;
      entry.cwd = cwdRaw.value ?? null;
      entry.containsEnvRef = entry.containsEnvRef || commandRaw.containsEnvRef || cwdRaw.containsEnvRef;
      // t33：`env`（agent 配置导入会带过来）→ 注入上游子进程环境；值同样支持环境变量引用。
      // 注意：env 的值**不写进任何事件**（`upstreamDescriptor()` 只记 command/args/cwd）。
      //
      // t49（真实事故的根因）：MCP SDK 的 stdio 客户端**只继承 12 个白名单环境变量**
      // （见 `@modelcontextprotocol/client/stdio` 的 getDefaultEnvironment()：APPDATA/HOMEDRIVE/HOMEPATH/
      //  LOCALAPPDATA/PATH/PROCESSOR_ARCHITECTURE/SYSTEMDRIVE/SYSTEMROOT/TEMP/USERNAME/USERPROFILE/PROGRAMFILES），
      // 其余（含 `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`）**会被丢弃**。
      // 所以「在启动终端里 set 一下就期望上游能拿到」是不成立的 —— **必须在清单里显式声明**，
      // 由 `transport.js` 把它们叠加到白名单之上传给子进程。
      // 值支持两类来源：`${VAR}`（从启动进程的环境解析，未设置 → 配置错误 exit 2，绝不用空串继续）
      // 与 `envFromFile`（从文件读，适合放在 `%LOCALAPPDATA%` 等用户目录、不必落进仓库）。
      if (item.env !== undefined) {
        if (item.env === null || typeof item.env !== 'object' || Array.isArray(item.env)) {
          errors.push(`${where}.env 必须是对象（键与值都按字符串处理）`);
          continue;
        }
        /** @type {Record<string, string>} */
        const envValues = {};
        // t49：`envOptional: ["KEY", ...]` —— 列在这里的键**允许未设置**（只警告并跳过），
        // 用于「示例清单在没配密钥的机器上也要能加载」。真正要用凭据时请**去掉**它，以便尽早 exit 2。
        const optionalKeys = Array.isArray(item.envOptional) ? item.envOptional.map((value) => String(value)) : [];
        for (const [envKey, envValue] of Object.entries(item.env)) {
          const errorsBefore = errors.length;
          const resolvedEnv = resolveTemplate(envValue, env, { errors, where: `${where}.env.${envKey}` });
          if (optionalKeys.includes(envKey) && errors.length > errorsBefore) {
            // 可选项：引用的环境变量没设置 → 把 resolveTemplate 记下的错误收回，改为警告并跳过。
            // （去掉清单里的 envOptional，同一条就会照常 exit 2 —— 这是「不得用空串继续」的默认行为。）
            errors.splice(errorsBefore);
            warnings.push(`${where}.env.${envKey} 引用的环境变量未设置，已按 envOptional 跳过（去掉 envOptional 就会 exit 2）`);
            continue;
          }
          if (typeof resolvedEnv.value !== 'string') {
            errors.push(`${where}.env.${envKey} 必须是字符串`);
            continue;
          }
          envValues[envKey] = resolvedEnv.value;
          entry.containsEnvRef = entry.containsEnvRef || resolvedEnv.containsEnvRef;
        }
        entry.env = envValues;
      }
      // t49：`envFromFile: { "GOOGLE_OAUTH_CLIENT_SECRET": "<path>" }` —— 逐键读文件内容作为该环境变量值。
      // 路径同样支持 `${VAR}`（例如 `${LOCALAPPDATA}\\mcp-cross-app-trace\\google-oauth-client-secret.txt`）。
      // 文件不存在/不可读 → 配置错误 exit 2；**错误信息只给键名与路径，绝不给文件内容**（秘密不进日志）。
      if (item.envFromFile !== undefined) {
        if (item.envFromFile === null || typeof item.envFromFile !== 'object' || Array.isArray(item.envFromFile)) {
          errors.push(`${where}.envFromFile 必须是对象（键 = 环境变量名，值 = 文件路径）`);
          continue;
        }
        /** @type {Record<string, string>} */
        const fileEnv = { ...(entry.env ?? {}) };
        for (const [envKey, rawSpec] of Object.entries(item.envFromFile)) {
          // 允许两种写法：`"KEY": "<path>"`（严格：读不到就 exit 2）
          // 或 `"KEY": { "path": "<path>", "optional": true }`（可选：文件不存在时**只警告**并跳过，
          // 让示例清单在没配密钥的机器上仍能加载；真正要用时请去掉 optional 以便尽早报错）。
          const spec = rawSpec !== null && typeof rawSpec === 'object' && !Array.isArray(rawSpec) ? rawSpec : { path: rawSpec };
          const optional = spec.optional === true;
          const resolvedPath = resolveTemplate(spec.path, env, { errors, where: `${where}.envFromFile.${envKey}` });
          const filePath = typeof resolvedPath.value === 'string' ? resolvedPath.value : null;
          if (!filePath) {
            errors.push(`${where}.envFromFile.${envKey} 必须是文件路径字符串`);
            continue;
          }
          const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
          let content;
          try {
            content = fs.readFileSync(absolute, 'utf8');
          } catch (error) {
            const detail = `读不到文件：${absolute}（${error instanceof Error ? error.message : String(error)}）`;
            if (optional) {
              warnings.push(`${where}.envFromFile.${envKey} ${detail} —— 已按 optional 跳过（上游会在真正需要时报错）`);
              continue;
            }
            errors.push(
              `${where}.envFromFile.${envKey} ${detail}；秘密请放在用户目录或仓库外，且必须可读 —— 不会用空值继续`,
            );
            continue;
          }
          const value = content.replace(/\r?\n+$/, '');
          if (value === '') {
            if (optional) {
              warnings.push(`${where}.envFromFile.${envKey} 文件内容为空：${absolute} —— 已按 optional 跳过`);
              continue;
            }
            errors.push(`${where}.envFromFile.${envKey} 文件内容为空：${absolute}（拒绝用空值继续）`);
            continue;
          }
          fileEnv[envKey] = value;
          entry.containsEnvRef = true; // 含秘密 → 描述符一律脱敏（见 transport.js 的 upstreamDescriptor）
        }
        entry.env = fileEnv;
      }
      // t33：`env_vars`（要继承的环境变量名）原样保留，便于「导入 → 对照」逐字段核对；
      // 运行期本项目给上游完整默认环境 + `env` 覆盖，故此处不再额外解释它。
      if (Array.isArray(item.env_vars)) entry.envVars = item.env_vars.map((value) => String(value));
      if (item.upstreamStderr !== null) {
        const stderrRaw = resolveTemplate(
          item.upstreamStderr ?? `demo-data/logs/${gatewayId}.upstream.stderr.log`,
          env,
          { errors, where: `${where}.upstreamStderr` },
        );
        entry.upstreamStderr = stderrRaw.value;
        entry.containsEnvRef = entry.containsEnvRef || stderrRaw.containsEnvRef;
      }
    } else {
      const urlRaw = resolveTemplate(item.url, env, { errors, where: `${where}.url` });
      const url = urlRaw.value;
      if (typeof url !== 'string' || url.trim() === '') {
        errors.push(`${where}.url 是 streamable-http 上游的必需字段`);
        continue;
      }
      try {
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          errors.push(`${where}.url 必须是 http(s) URL（当前 ${JSON.stringify(url)}）`);
          continue;
        }
      } catch {
        errors.push(`${where}.url 不是合法 URL（当前 ${JSON.stringify(url)}）`);
        continue;
      }
      const headersSource = item.headers ?? {};
      if (headersSource === null || typeof headersSource !== 'object' || Array.isArray(headersSource)) {
        errors.push(`${where}.headers 必须是对象`);
        continue;
      }
      /** @type {Record<string, string>} */
      const headers = {};
      let headersContainEnvRef = false;
      let tokenRefContainsEnvRef = false;
      /** @type {string[]} */
      const tokenRefs = [];
      for (const [name, headerValue] of Object.entries(headersSource)) {
        // t35：`${oauth:<提供者>}` 是**令牌引用**，这里**不解析**（解析要读凭证文件/可能刷新，属启动期行为），
        // 只收集并做静态校验；真正替换发生在 gatewayConfigFor()。
        const refs = collectOAuthRefs(headerValue);
        if (refs.length > 0) {
          const resolvedHeader = resolveTemplate(headerValue, env, { errors, where: `${where}.headers.${name}` });
          if (typeof resolvedHeader.value !== 'string') {
            errors.push(`${where}.headers.${name} 必须是字符串`);
            continue;
          }
          headers[name] = resolvedHeader.value;
          for (const ref of refs) if (!tokenRefs.includes(ref)) tokenRefs.push(ref);
          tokenRefContainsEnvRef = tokenRefContainsEnvRef || resolvedHeader.containsEnvRef;
          continue;
        }
        const resolvedHeader = resolveTemplate(headerValue, env, { errors, where: `${where}.headers.${name}` });
        if (typeof resolvedHeader.value !== 'string') {
          errors.push(`${where}.headers.${name} 必须是字符串`);
          continue;
        }
        headers[name] = resolvedHeader.value;
        headersContainEnvRef = headersContainEnvRef || resolvedHeader.containsEnvRef;
      }
      // 未知提供者 = 静态错误（可辨识，退出码 2），绝不等到启动时才炸
      for (const ref of tokenRefs) {
        if (!oauthProviders.has(ref)) {
          errors.push(
            `${where}.headers 引用了未知的令牌提供者 "${ref}"：请在清单顶层 oauthProviders 里声明它` +
              (oauthProviders.size > 0 ? `（已声明的：${[...oauthProviders.keys()].join(', ')}）` : '（当前一个都没声明）'),
          );
        }
      }
      if (typeof url === 'string' && collectOAuthRefs(url).length > 0) {
        errors.push(`${where}.url 不支持令牌引用：令牌只允许放在 headers 里（避免它出现在 URL/日志中）`);
      }
      entry.url = url;
      entry.urlContainsEnvRef = urlRaw.containsEnvRef;
      entry.headers = headers;
      entry.headersContainEnvRef = headersContainEnvRef || tokenRefContainsEnvRef;
      entry.tokenRefs = tokenRefs;
      entry.containsEnvRef = entry.containsEnvRef || urlRaw.containsEnvRef || entry.headersContainEnvRef;
    }

    upstreams.push(entry);
  }

  // 标识类字段沿用 stdio 版的占位符守卫（尖括号/YOUR_/未展开 ${} 一律拒绝）
  const identifierConfig = {
    experimentRunId,
    clientLabel,
    upstreamApp: upstreams[0]?.upstreamApp,
    gatewayId: upstreams[0]?.gatewayId,
    dbPath,
  };
  assertNoPlaceholders(identifierConfig, errors);
  for (const entry of upstreams) {
    assertNoPlaceholders({ gatewayId: entry.gatewayId, upstreamApp: entry.upstreamApp }, errors);
  }

  if (errors.length > 0) return { ok: false, manifest: null, errors, warnings, path: absolute };

  return {
    ok: true,
    manifest: {
      version: MANIFEST_VERSION,
      experimentRunId,
      clientLabel,
      dbPath,
      http: { host, port },
      upstreams,
      // t35：令牌提供者（Map<名字, 配置>）。启动期由调用方解析成「当前有效 access token」，
      // 这里只做静态校验（未知提供者 / 缺端点 / 仓库内 store 都已在上面报错）。
      oauthProviders,
      path: absolute,
    },
    errors,
    warnings,
    path: absolute,
  };
}

/**
 * 上游 → `createGateway()` 需要的 config（每个上游一份，**共享同一个 run id**）。
 * @param {Record<string, any>} entry
 * @param {{manifest: Record<string, any>, maxPayloadBytes?: number, traceEnabled?: boolean,
 *   tokenValues?: Map<string, string>}} context
 */
export function gatewayConfigFor(entry, context) {
  /** @type {Record<string, any>} */
  const config = {
    gatewayId: entry.gatewayId,
    upstreamApp: entry.upstreamApp,
    clientLabel: entry.clientLabel,
    experimentRunId: entry.experimentRunId,
    dbPath: entry.dbPath,
    timeoutMs: entry.timeoutMs,
    transport: entry.transport,
    traceEnabled: context.traceEnabled !== false,
    upstreamArgs: entry.args ?? [],
    upstreamCwd: entry.cwd ?? null,
  };
  if (context.maxPayloadBytes !== undefined) config.maxPayloadBytes = context.maxPayloadBytes;
  if (entry.transport === 'stdio') {
    config.upstreamCommand = entry.command;
    if (entry.env !== undefined) config.upstreamEnv = { ...entry.env };
    if (entry.upstreamStderr !== undefined) config.upstreamStderr = entry.upstreamStderr;
  } else {
    config.upstreamUrl = entry.url;
    // t35：把 `${oauth:<提供者>}` 换成**当前有效**的 access token。
    // 缺令牌 → 明确报错（绝不退化成空串：那就是「静默用空令牌继续」）。
    /** @type {Record<string, string>} */
    const resolvedHeaders = {};
    /** @type {string[]} */
    const missingTokens = [];
    for (const [name, value] of Object.entries(entry.headers ?? {})) {
      const substituted = substituteOAuthRefs(value, context.tokenValues ?? new Map());
      for (const provider of substituted.missing) if (!missingTokens.includes(provider)) missingTokens.push(provider);
      resolvedHeaders[name] = String(substituted.value);
    }
    if (missingTokens.length > 0) {
      throw new Error(
        `上游 ${entry.serverName} 的 headers 需要令牌提供者 ${missingTokens.join(', ')}，但当前没有可用令牌：` +
          '请先 node bin\\oauth-login.js --login，或用 --status 查看令牌状态（不得用空令牌继续）',
      );
    }
    config.upstreamHeaders = resolvedHeaders;
    config.upstreamUrlContainsEnvRef = entry.urlContainsEnvRef === true;
    // HTTP 上游没有 stderr 流：显式关闭采集，不为它建日志文件（也就不会有空文件垃圾）。
    config.upstreamStderrDisabled = true;
  }
  return config;
}

/** @returns {string} 清单用法说明（供 --help 输出） */
export function manifestUsage() {
  return [
    '清单（trace.manifest.json）字段：',
    '  experimentRunId  必需。本次实验的运行 ID——**一个 run id 覆盖清单里全部上游**（不再人工对齐参数）',
    '  clientLabel      必需。deterministic | codex | deepseek_harness',
    `  db               事件库路径（缺省 ${DEFAULT_DB_PATH}）`,
    `  http.port        本进程 HTTP 监听端口（缺省 ${DEFAULT_HTTP_PORT}；0 = 任意空闲端口）；host 固定 ${DEFAULT_HTTP_HOST}`,
    '  upstreams[]      每个上游：serverName / upstreamApp / gatewayId / path（缺省 /<serverName>/mcp）/ transport',
    '     - transport=stdio：command（缺省=当前 node）、args[]、cwd、upstreamStderr',
    '     - transport=streamable-http：url、headers{}（值支持环境变量引用 `$` + `{VAR}`，',
    '       以及令牌提供者引用 `$` + `{oauth:名字}`；提供者在顶层 oauthProviders 里声明）',
    '  oauthProviders   可选。{ "google": { "store": "default", "tokenEndpoint": "…", "clientId": "…" } }——',
    '     `store` 缺省 "default"（用户目录里的凭证文件，由 bin/oauth-login.js 登录生成）；',
    '     启动时按需自动刷新，令牌绝不写入事件库/日志',
    '',
    '约定（重要，供工具与同事实参照）：',
    '  · **以 `_` 开头的键是文档**（`_readme` / `_usage` / `_httpUpstreamExample` …），',
    '    一律不参与取值与校验——这样「给人看的示例」不会污染「真正生效的配置」。',
    '  · 任意字符串字段都支持环境变量引用（写 `$` + `{VAR}`）；**引用的变量未设置 = 配置错误**',
    '    （不会用空串继续，否则会拿着空令牌去连远端，报错还很难懂）。',
    '  · 密钥纪律：HTTP 头的**值**绝不写入事件库/日志/证据（事件只记头名与 <redacted>）；',
    '    URL 里含环境变量引用时整段 URL 记为 <redacted>。',
  ].join('\n');
}
