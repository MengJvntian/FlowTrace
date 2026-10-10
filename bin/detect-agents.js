#!/usr/bin/env node
/**
 * bin/detect-agents.js — 只读「可监控 agent 自动检测」（t41）
 *
 * 用户需求：「启动后自动检测电脑上下载的可监控的 agent」——一条命令就知道本机**有哪些 MCP 客户端
 * 可以被监控、各自差哪一步**。（「在 agent 内显示界面」不可行：客户端 UI 不对外开放；显示面是
 * `t40` 负责自动打开的浏览器页面。本工具负责「发现层」。）
 *
 * 硬纪律：
 *   1. **零写入**：默认只打印，一个字节都不写；不创建 `mcp.json`、不碰 `~/.codex` / `~/.dsh` / `~/.cursor`。
 *      唯一的写盘入口是显式 `--out <仓库内或系统临时目录路径>`（用户配置目录一律拒绝，exit 2）。
 *   2. **判断必须有路径级证据**：每个「已安装/仅残留/未检测到」都由具体路径的存在性推出；
 *      没有证据就写「未检测到」，**不猜**（判定口径沿用 `相关实现` §1 的实测标准）。
 *   3. `--help` 只打印用法并 exit 0：不扫描任何客户端、不写任何文件。
 *
 * 退出码：0 成功（无论检测到什么；没有可监控客户端也是 0）/ 2 用法错误。
 * 输出：人读表格 + 每个客户端的「接入动作」（可复制）走 stdout；诊断走 stderr。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CliError, parseOptions } from '../src/cli/args.js';
import { out as stdoutLine, renderTable, toJson } from '../src/cli/format.js';
import {
  BUNDLE_DIRNAME,
  REPO_ROOT,
  buildConfigs,
  clientNotes,
  isInsideRepo,
  resolvePaths as resolveWrapPaths,
} from './wrap-config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 三态：已安装 / 仅残留 / 未检测到。 */
export const INSTALL_STATE = Object.freeze({
  INSTALLED: 'installed',
  RESIDUAL_ONLY: 'residual_only',
  NOT_DETECTED: 'not_detected',
});

/** 接入状态：已接入本平台 / 可接入 / 未安装。 */
export const PLATFORM_STATE = Object.freeze({
  CONNECTED: 'connected',
  READY: 'ready_to_connect',
  NOT_INSTALLED: 'not_installed',
});

export const INSTALL_STATE_LABEL = Object.freeze({
  [INSTALL_STATE.INSTALLED]: '已安装',
  [INSTALL_STATE.RESIDUAL_ONLY]: '仅残留',
  [INSTALL_STATE.NOT_DETECTED]: '未检测到',
});

export const PLATFORM_STATE_LABEL = Object.freeze({
  [PLATFORM_STATE.CONNECTED]: '已接入',
  [PLATFORM_STATE.READY]: '可接入',
  [PLATFORM_STATE.NOT_INSTALLED]: '未安装',
});

/**
 * 「已接入本平台」的文本标记（与 `bin/wrap-config.js` 生成的片段一致）。
 * 命中任一即视为该客户端已配置了本平台的 Gateway 上游。
 */
export const PLATFORM_MARKERS = Object.freeze([
  'bin\\gateway.js',
  'bin/gateway.js',
  'bin\\gateway-http.js',
  'bin/gateway-http.js',
  'bin\\trace-manager.js',
  'bin/trace-manager.js',
  'bin\\serve.js',
  'bin/serve.js',
  'mcp-trace',
  '@local/mcp-trace',
]);

/** 主表覆盖的客户端（验收要求的 5 个）+ 其它常见客户端（同一判据，次要展示）。 */
export const PRIMARY_CLIENT_IDS = Object.freeze(['codex', 'deepseek_harness', 'vscode', 'claude_desktop', 'cursor']);
export const EXTENDED_CLIENT_IDS = Object.freeze(['windsurf', 'zed', 'continue', 'lmstudio']);

export const DETECT_SCHEMA = 'mcp-cross-app-trace/detect-agents/1';

/**
 * 归一化「环境」：测试用具夹 HOME/APPDATA/LOCALAPPDATA/PATH 注入，绝不依赖本机真实状态。
 * @param {{env?: Record<string, string | undefined>, home?: string, appdata?: string, localappdata?: string, pathValue?: string}} [input]
 * @returns {{home: string, appdata: string, localappdata: string, pathValue: string, env: Record<string, string|undefined>}}
 */
export function resolveEnv(input = {}) {
  const env = { ...(input.env ?? process.env) };
  const home = input.home ?? env.USERPROFILE ?? env.HOME ?? '';
  const appdata = input.appdata ?? env.APPDATA ?? (home ? path.join(home, 'AppData', 'Roaming') : '');
  const localappdata = input.localappdata ?? env.LOCALAPPDATA ?? (home ? path.join(home, 'AppData', 'Local') : '');
  const pathValue = input.pathValue ?? env.PATH ?? env.Path ?? '';
  return { home, appdata, localappdata, pathValue, env };
}

/**
 * 在 PATH 里找可执行文件（只做**路径存在性**判断，不抓任何命令输出）。
 * @param {string} pathValue
 * @param {string[]} names 例如 ['code.cmd', 'code.exe', 'code']
 * @returns {Array<{name: string, path: string, exists: boolean}>}
 */
export function lookupInPath(pathValue, names) {
  const dirs = String(pathValue).split(path.delimiter).filter((dir) => dir.trim() !== '');
  /** @type {Array<{name: string, path: string, exists: boolean}>} */
  const results = [];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) results.push({ name, path: candidate, exists: true });
    }
  }
  return results;
}

/**
 * 逐个候选路径做存在性检查（**只读**）。
 * @param {Array<{kind: string, path: string, note?: string}>} candidates
 * @returns {Array<{kind: string, path: string, exists: boolean, is_dir: boolean|null, note: string|null}>}
 */
export function checkCandidates(candidates) {
  return candidates
    .filter((candidate) => typeof candidate.path === 'string' && candidate.path !== '')
    .map((candidate) => {
      let exists = false;
      let isDir = null;
      try {
        const stat = fs.statSync(candidate.path);
        exists = true;
        isDir = stat.isDirectory();
      } catch {
        exists = false;
      }
      return { kind: candidate.kind, path: candidate.path, exists, is_dir: isDir, note: candidate.note ?? null };
    });
}

/** @param {string} dir @returns {string[]} 子目录名（不存在时返回空数组，只读） */
export function listSubdirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** @param {string} file @returns {string|null} 文件内容（不存在/读失败返回 null，只读） */
export function readTextIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** @param {unknown} value @returns {string} 统一 POSIX 化的路径，便于比对与展示 */
function normalizeSlashes(value) {
  return String(value ?? '').split(path.sep).join('/');
}

/**
 * 平台标记扫描（文本级，只读）。
 *
 * 关键细节：配置里的路径可能出现三种写法 —— `C:\repo\bin\gateway.js`（TOML/YAML 字面量）、
 * `"C:\\repo\\bin\\gateway.js"`（JSON 里被转义的 `\\`）、`C:/repo/bin/gateway.js`（正斜杠）。
 * 因此比较前把**连续的 `/` 或 `\` 折叠成一个 `/`**，三种写法都能命中（否则 JSON 配置会漏判）。
 * @param {Array<{where: string, text: string|null}>} sources
 * @returns {Array<{where: string, marker: string}>}
 */
export function findPlatformMarkers(sources) {
  const collapse = (value) => String(value).replace(/[\\/]+/gu, '/');
  /** @type {Array<{where: string, marker: string}>} */
  const hits = [];
  for (const source of sources) {
    if (typeof source.text !== 'string' || source.text === '') continue;
    const normalized = collapse(source.text);
    for (const marker of PLATFORM_MARKERS) {
      const needle = collapse(marker);
      if (normalized.includes(needle) && !hits.some((hit) => hit.where === source.where && hit.marker === marker)) {
        hits.push({ where: source.where, marker });
      }
    }
  }
  return hits;
}

/**
 * 统计 TOML 里 `[mcp_servers.<名字>]` 顶层块（**排除** `<名字>.env` 之类的子表）。
 * @param {string|null} text
 * @returns {{count: number, names: string[]}}
 */
export function countTomlMcpServers(text) {
  if (typeof text !== 'string') return { count: 0, names: [] };
  /** @type {string[]} */
  const names = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*\[mcp_servers\.([^\]]+)\]\s*$/u.exec(line);
    if (!match) continue;
    const name = match[1].trim();
    if (name.includes('.')) continue; // 子表（例如 mcp_servers.<name>.env）不是独立 server
    if (!names.includes(name)) names.push(name);
  }
  return { count: names.length, names };
}

/**
 * 统计 JSON 配置里的 server 条目（`servers` 或 `mcpServers`）。
 * @param {string|null} text
 * @param {'servers'|'mcpServers'} key
 * @returns {{count: number, names: string[], parse_error: string|null}}
 */
export function countJsonServers(text, key) {
  if (typeof text !== 'string' || text.trim() === '') return { count: 0, names: [], parse_error: null };
  try {
    const parsed = JSON.parse(text);
    const container = parsed && typeof parsed === 'object' ? parsed[key] : null;
    if (!container || typeof container !== 'object' || Array.isArray(container)) return { count: 0, names: [], parse_error: null };
    const names = Object.keys(container).sort();
    return { count: names.length, names, parse_error: null };
  } catch (error) {
    return { count: 0, names: [], parse_error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 统计文本里某个标记出现次数（用于 DSH 的 `@deepseek-ai/dsh-mcp-client` 条目数）。
 * @param {string|null} text
 * @param {string} needle
 * @returns {number}
 */
export function countOccurrences(text, needle) {
  if (typeof text !== 'string' || text === '') return 0;
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// 各客户端检测
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Codex：`~/.codex/config.toml` + `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`（口径见 clients-adapters §1）。
 * @param {ReturnType<typeof resolveEnv>} env
 */
export function detectCodex(env) {
  const codexBinRoot = env.localappdata ? path.join(env.localappdata, 'OpenAI', 'Codex', 'bin') : '';
  /** @type {Array<{kind: string, path: string, note?: string}>} */
  const installCandidates = [];
  for (const hash of env.localappdata ? listSubdirs(codexBinRoot) : []) {
    installCandidates.push({ kind: 'executable', path: path.join(codexBinRoot, hash, 'codex.exe'), note: 'Codex CLI 二进制' });
  }
  for (const hit of lookupInPath(env.pathValue, ['codex.exe', 'codex.cmd', 'codex'])) {
    installCandidates.push({ kind: 'executable', path: hit.path, note: `PATH 命中 ${hit.name}` });
  }
  const configPath = env.home ? path.join(env.home, '.codex', 'config.toml') : '';
  const configDir = env.home ? path.join(env.home, '.codex') : '';
  installCandidates.push({ kind: 'config_dir', path: configDir, note: 'Codex 配置目录（有它但没有可执行文件时也会标记为「已安装（仅配置）」）' });
  const installEvidence = checkCandidates(installCandidates);
  const configText = readTextIfExists(configPath);
  const servers = countTomlMcpServers(configText);
  const markers = findPlatformMarkers([
    { where: configPath, text: configText },
    { where: configDir, text: null },
  ]);
  return {
    id: 'codex',
    name: 'Codex（CLI/桌面）',
    install_evidence: installEvidence,
    install_state: decideInstallState(installEvidence),
    config: {
      path: configPath,
      exists: configText !== null,
      format: 'toml',
      entry_key: 'mcp_servers.<name>',
      entry_count: servers.count,
      entry_names: servers.names,
      parse_error: null,
    },
    platform: { markers, bundle_installed: null },
  };
}

/**
 * DeepSeek Harness：`~/.dsh/profiles/<profile>/`（`package.json` 的依赖与 `dsh.profile.bundles` = bundle 安装痕迹）。
 * @param {ReturnType<typeof resolveEnv>} env
 * @returns {Record<string, any>}
 */
export function detectDeepSeekHarness(env) {
  const dshDir = env.home ? path.join(env.home, '.dsh') : '';
  const profilesDir = dshDir ? path.join(dshDir, 'profiles') : '';
  const profileNames = dshDir ? listSubdirs(profilesDir) : [];
  /** @type {Array<{kind: string, path: string, note?: string}>} */
  const installCandidates = [
    { kind: 'config_dir', path: dshDir, note: 'DSH 用户数据目录' },
  ];
  for (const name of profileNames) installCandidates.push({ kind: 'profile_dir', path: path.join(profilesDir, name), note: `profile：${name}` });
  const installEvidence = checkCandidates(installCandidates);

  /** @type {Array<Record<string, any>>} */
  const profiles = [];
  let totalEntries = 0;
  /** @type {Array<{where: string, text: string|null}>} */
  const markerSources = [];
  /** @type {Array<{where: string, marker: string}>} */
  const bundleTraces = [];

  for (const profileName of profileNames) {
    const profileDir = path.join(profilesDir, profileName);
    const packagePath = path.join(profileDir, 'package.json');
    const profilePatch = path.join(profileDir, 'cordis.patch.yml');
    const packageText = readTextIfExists(packagePath);
    const profilePatchText = readTextIfExists(profilePatch);
    /** @type {{dependencies?: Record<string, string>, dsh?: any}} */
    let manifest = {};
    try {
      manifest = packageText ? JSON.parse(packageText) : {};
    } catch {
      manifest = {};
    }
    const dependencies = manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {};
    const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
    /** @type {string[]} */
    const traceDeps = Object.keys(dependencies).filter((name) => /mcp-trace/i.test(name));
    const traceBundles = bundles.filter((name) => /mcp-trace/i.test(String(name)));
    for (const name of traceDeps) {
      bundleTraces.push({ where: `${profileName}/package.json:dependencies`, marker: name });
      markerSources.push({ where: `profile ${profileName} 依赖`, text: `${name} ${dependencies[name]}` });
    }
    for (const name of traceBundles) {
      bundleTraces.push({ where: `${profileName}/package.json:dsh.profile.bundles`, marker: name });
    }

    // 条目计数：profile 自己的 patch + 每个已安装 bundle 的 patch（`dsh.bundle.patch`）
    /** @type {Array<{where: string, path: string, entries: number}>} */
    const patchSources = [];
    if (profilePatchText !== null) {
      patchSources.push({ where: `${profileName}/cordis.patch.yml`, path: profilePatch, entries: countOccurrences(profilePatchText, '@deepseek-ai/dsh-mcp-client') });
      markerSources.push({ where: `${profileName}/cordis.patch.yml`, text: profilePatchText });
    }
    for (const [depName, depSpec] of Object.entries(dependencies)) {
      let bundleDir = '';
      const spec = String(depSpec);
      if (spec.startsWith('link:')) {
        const raw = spec.slice('link:'.length);
        bundleDir = path.isAbsolute(raw) ? raw : path.join(profileDir, raw);
      } else {
        bundleDir = path.join(profileDir, 'node_modules', depName);
      }
      const bundleManifestText = readTextIfExists(path.join(bundleDir, 'package.json'));
      if (bundleManifestText === null) continue;
      let bundleManifest = null;
      try {
        bundleManifest = JSON.parse(bundleManifestText);
      } catch {
        bundleManifest = null;
      }
      const patchRel = bundleManifest?.dsh?.bundle?.patch;
      if (typeof patchRel !== 'string' || patchRel === '') continue;
      const patchPath = path.resolve(bundleDir, patchRel);
      const patchText = readTextIfExists(patchPath);
      if (patchText === null) continue;
      patchSources.push({ where: `${depName} → ${path.relative(profileDir, patchPath) || patchPath}`, path: patchPath, entries: countOccurrences(patchText, '@deepseek-ai/dsh-mcp-client') });
      markerSources.push({ where: `${depName} bundle patch`, text: patchText });
    }
    const profileEntries = patchSources.reduce((sum, item) => sum + item.entries, 0);
    totalEntries += profileEntries;
    profiles.push({
      profile: profileName,
      dir: profileDir,
      package_json: packagePath,
      package_exists: packageText !== null,
      patch: profilePatch,
      patch_exists: profilePatchText !== null,
      dependency_count: Object.keys(dependencies).length,
      bundle_count: bundles.length,
      mcp_client_entries: profileEntries,
      patch_sources: patchSources.map((item) => ({ where: item.where, path: normalizedPath(item.path), entries: item.entries })),
      trace_bundle_dependencies: traceDeps,
      trace_bundle_in_profile_bundles: traceBundles,
    });
  }

  const markers = findPlatformMarkers(markerSources);
  return {
    id: 'deepseek_harness',
    name: 'DeepSeek Harness（DSH）',
    install_evidence: installEvidence,
    install_state: decideInstallState(installEvidence),
    config: {
      path: profilesDir,
      exists: dshDir !== '' && fs.existsSync(profilesDir),
      format: 'yaml+json（每个 profile：cordis.patch.yml + package.json）',
      entry_key: "@deepseek-ai/dsh-mcp-client 条目（profile patch + 已安装 bundle 的 patch）",
      entry_count: totalEntries,
      entry_names: profiles.flatMap((profile) => profile.patch_sources.map((item) => `${profile.profile}:${item.where}`)),
      parse_error: null,
    },
    platform: { markers, bundle_installed: bundleTraces.length > 0, bundle_traces: bundleTraces },
    profiles,
  };
}

/**
 * VS Code：`%APPDATA%\Code\User\mcp.json` + PATH 里的 `code.cmd`（口径见 clients-adapters §1/§2）。
 * @param {ReturnType<typeof resolveEnv>} env
 */
export function detectVsCode(env) {
  /** @type {Array<{kind: string, path: string, note?: string}>} */
  const installCandidates = [];
  for (const hit of lookupInPath(env.pathValue, ['code.cmd', 'code.exe', 'code'])) {
    installCandidates.push({ kind: 'executable', path: hit.path, note: `PATH 命中 ${hit.name}` });
  }
  const codeUserDir = env.appdata ? path.join(env.appdata, 'Code', 'User') : '';
  const codeDir = env.appdata ? path.join(env.appdata, 'Code') : '';
  installCandidates.push({ kind: 'config_dir', path: codeUserDir, note: 'VS Code 用户配置目录' });
  const installEvidence = checkCandidates(installCandidates);
  const configPath = codeUserDir ? path.join(codeUserDir, 'mcp.json') : '';
  const configText = readTextIfExists(configPath);
  const servers = countJsonServers(configText, 'servers');
  const markers = findPlatformMarkers([{ where: configPath, text: configText }]);
  return {
    id: 'vscode',
    name: 'VS Code',
    install_evidence: installEvidence,
    install_state: decideInstallState(installEvidence),
    config: { path: configPath, exists: configText !== null, format: 'json', entry_key: 'servers', entry_count: servers.count, entry_names: servers.names, parse_error: servers.parse_error },
    platform: { markers, bundle_installed: null },
    extra_dirs: [{ path: codeDir, note: 'VS Code 数据目录（存在≠已装：可能是其它产品的残留）' }],
  };
}

/**
 * Claude Desktop：`%LOCALAPPDATA%\AnthropicClaude` / `Programs\Claude` + `%APPDATA%\Claude\claude_desktop_config.json`。
 *
 * **特别说明（照 clients-adapters §1 的口径）**：`~/.claude` 是 **Claude Code** 的数据目录，
 * **不是** Claude Desktop 的安装证据；它只作为「其它产品的残留/无关目录」单列，不参与判定。
 * @param {ReturnType<typeof resolveEnv>} env
 */
export function detectClaudeDesktop(env) {
  /** @type {Array<{kind: string, path: string, note?: string}>} */
  const installCandidates = [
    { kind: 'install_dir', path: env.localappdata ? path.join(env.localappdata, 'AnthropicClaude') : '', note: 'Claude Desktop 安装目录（官方安装器）' },
    { kind: 'install_dir', path: env.localappdata ? path.join(env.localappdata, 'Programs', 'Claude') : '', note: 'Claude Desktop 安装目录（用户级 Programs）' },
  ];
  for (const hit of lookupInPath(env.pathValue, ['claude.exe'])) installCandidates.push({ kind: 'executable', path: hit.path, note: 'PATH 命中 claude.exe' });
  const configPath = env.appdata ? path.join(env.appdata, 'Claude', 'claude_desktop_config.json') : '';
  installCandidates.push({ kind: 'config_file', path: configPath, note: 'Claude Desktop 的 MCP 配置（有它即视为已安装并已配置）' });
  const installEvidence = checkCandidates(installCandidates);

  const residualCandidates = [
    { kind: 'cache_dir', path: env.appdata ? path.join(env.appdata, 'Claude') : '', note: 'Claude 缓存目录（只有它 = 仅残留）' },
  ];
  const residualEvidence = checkCandidates(residualCandidates);
  const unrelated = checkCandidates([{ kind: 'other_product', path: env.home ? path.join(env.home, '.claude') : '', note: 'Claude **Code** 的数据目录，不是 Claude Desktop，不参与判定' }]);

  const configText = readTextIfExists(configPath);
  const servers = countJsonServers(configText, 'mcpServers');
  const markers = findPlatformMarkers([{ where: configPath, text: configText }]);
  return {
    id: 'claude_desktop',
    name: 'Claude Desktop',
    install_evidence: installEvidence,
    install_state: decideInstallState(installEvidence, residualEvidence),
    residual_evidence: residualEvidence,
    unrelated_evidence: unrelated,
    config: { path: configPath, exists: configText !== null, format: 'json', entry_key: 'mcpServers', entry_count: servers.count, entry_names: servers.names, parse_error: servers.parse_error },
    platform: { markers, bundle_installed: null },
  };
}

/**
 * Cursor：`~/.cursor/mcp.json` + `%LOCALAPPDATA%\Programs\cursor\Cursor.exe`；
 * `%APPDATA%\Cursor`（日志/缓存）单独作为**残留**证据（口径见 clients-adapters §1）。
 * @param {ReturnType<typeof resolveEnv>} env
 */
export function detectCursor(env) {
  /** @type {Array<{kind: string, path: string, note?: string}>} */
  const installCandidates = [
    { kind: 'executable', path: env.localappdata ? path.join(env.localappdata, 'Programs', 'cursor', 'Cursor.exe') : '', note: '用户级安装的 Cursor.exe' },
    { kind: 'executable', path: env.localappdata ? path.join(env.localappdata, 'Programs', 'Cursor', 'Cursor.exe') : '', note: '用户级安装的 Cursor.exe（大写目录）' },
  ];
  for (const hit of lookupInPath(env.pathValue, ['cursor.exe', 'Cursor.exe', 'cursor.cmd'])) {
    installCandidates.push({ kind: 'executable', path: hit.path, note: `PATH 命中 ${hit.name}` });
  }
  const configPath = env.home ? path.join(env.home, '.cursor', 'mcp.json') : '';
  installCandidates.push({ kind: 'config_file', path: configPath, note: 'Cursor 的 MCP 配置（有它即视为已安装并已配置）' });
  const installEvidence = checkCandidates(installCandidates);

  const residualEvidence = checkCandidates([{ kind: 'cache_dir', path: env.appdata ? path.join(env.appdata, 'Cursor') : '', note: 'Cursor 日志/缓存目录（只有它 = 仅残留，未见可执行文件与 mcp.json）' }]);
  const configText = readTextIfExists(configPath);
  const servers = countJsonServers(configText, 'mcpServers');
  const markers = findPlatformMarkers([{ where: configPath, text: configText }]);
  return {
    id: 'cursor',
    name: 'Cursor',
    install_evidence: installEvidence,
    install_state: decideInstallState(installEvidence, residualEvidence),
    residual_evidence: residualEvidence,
    config: { path: configPath, exists: configText !== null, format: 'json', entry_key: 'mcpServers', entry_count: servers.count, entry_names: servers.names, parse_error: servers.parse_error },
    platform: { markers, bundle_installed: null },
  };
}

/**
 * 其它常见 MCP 客户端（同一判据；只做「装没装 + MCP 配置路径」级别判断，不渲染为主表）。
 * @param {'windsurf'|'zed'|'continue'|'lmstudio'} id
 * @param {ReturnType<typeof resolveEnv>} env
 */
export function detectOtherClient(id, env) {
  /** @type {Record<string, {name: string, dirs: string[], configs: Array<{path: string, format: string, key: string}>}>} */
  const specs = {
    windsurf: {
      name: 'Windsurf',
      dirs: [env.appdata ? path.join(env.appdata, 'Windsurf') : ''],
      configs: [{ path: env.home ? path.join(env.home, '.codeium', 'windsurf', 'mcp_config.json') : '', format: 'json', key: 'mcpServers' }],
    },
    zed: {
      name: 'Zed',
      dirs: [env.appdata ? path.join(env.appdata, 'Zed') : ''],
      configs: [{ path: env.home ? path.join(env.home, '.config', 'zed', 'settings.json') : '', format: 'json', key: 'context_servers' }],
    },
    continue: {
      name: 'Continue',
      dirs: [env.home ? path.join(env.home, '.continue') : ''],
      configs: [{ path: env.home ? path.join(env.home, '.continue', 'config.json') : '', format: 'json', key: 'mcpServers' }],
    },
    lmstudio: {
      name: 'LM Studio',
      dirs: [env.appdata ? path.join(env.appdata, 'LM Studio') : ''],
      configs: [{ path: env.home ? path.join(env.home, '.lmstudio', 'mcp.json') : '', format: 'json', key: 'mcpServers' }],
    },
  };
  const spec = specs[id];
  const installEvidence = checkCandidates([
    ...spec.dirs.map((dir) => ({ kind: 'install_dir', path: dir, note: `${spec.name} 数据/安装目录` })),
    ...spec.configs.map((config) => ({ kind: 'config_file', path: config.path, note: 'MCP 配置' })),
  ]);
  const [config] = spec.configs;
  const configText = readTextIfExists(config.path);
  const servers = countJsonServers(configText, config.key);
  return {
    id,
    name: spec.name,
    extended: true,
    install_evidence: installEvidence,
    install_state: decideInstallState(installEvidence),
    config: { path: config.path, exists: configText !== null, format: config.format, entry_key: config.key, entry_count: servers.count, entry_names: servers.names, parse_error: servers.parse_error },
    platform: { markers: findPlatformMarkers([{ where: config.path, text: configText }]), bundle_installed: null },
  };
}

/**
 * 三态判定：**强证据**（可执行文件/安装目录/配置文件/配置目录）优先于**残留证据**。
 * @param {Array<{kind: string, exists: boolean}>} installEvidence
 * @param {Array<{kind: string, exists: boolean}>} [residualEvidence]
 * @returns {string} INSTALL_STATE 之一
 */
export function decideInstallState(installEvidence, residualEvidence = []) {
  if (installEvidence.some((item) => item.exists === true)) return INSTALL_STATE.INSTALLED;
  if (residualEvidence.some((item) => item.exists === true)) return INSTALL_STATE.RESIDUAL_ONLY;
  return INSTALL_STATE.NOT_DETECTED;
}

/** @param {string} value @returns {string} 展示用路径（统一正斜杠） */
function normalizedPath(value) {
  return String(value ?? '').split(path.sep).join('/');
}

/**
 * `--probe-cli`：用**退出码**证明「这个客户端 CLI 真的能跑」（stdio=ignore：不抓输出、不写文件）。
 * 默认关闭；开了它才会 spawn 进程。
 * @param {{command: string, args?: string[]}} input
 * @returns {{ran: boolean, exit_code: number|null, mode: string, error: string|null}}
 */
export function probeCliExitCode(input) {
  /** @type {{ran: boolean, exit_code: number|null, mode: string, error: string|null}} */
  const result = { ran: false, exit_code: null, mode: 'none', error: null };
  const command = String(input.command ?? '');
  if (command === '') {
    result.error = 'empty command';
    return result;
  }
  const args = input.args ?? ['--version'];
  try {
    const isCmdScript = /\.(cmd|bat)$/iu.test(command);
    const spawnArgs = isCmdScript ? ['/c', command, ...args] : args;
    const spawnCommand = isCmdScript ? 'cmd' : command;
    const outcome = spawnSync(spawnCommand, spawnArgs, { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    result.ran = true;
    result.mode = isCmdScript ? 'cmd /c <script> --version' : '<exe> --version';
    result.exit_code = typeof outcome.status === 'number' ? outcome.status : null;
    if (outcome.error) result.error = String(outcome.error.message ?? outcome.error);
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }
}

/**
 * 给「已安装」的客户端补一条 CLI 退出码证据（仅在 `--probe-cli` 时调用）。
 * @param {Array<Record<string, any>>} clients
 * @param {{timeoutMs?: number}} [options]
 */
export function attachCliProbes(clients, options = {}) {
  return clients.map((client) => {
    const target = pickProbeTarget(client);
    if (!target) return client;
    const probe =
      typeof options.runner === 'function'
        ? options.runner(target)
        : probeCliExitCode({ command: target.command, args: target.args });
    return {
      ...client,
      cli_probe: {
        command: target.command,
        args: target.args ?? ['--version'],
        rationale: target.rationale,
        ...probe,
        evidence_kind: 'cli_exit_code',
      },
    };
  });
}

/**
 * @param {Record<string, any>} client
 * @returns {{command: string, args?: string[], rationale: string}|null}
 */
function pickProbeTarget(client) {
  const executable = (client.install_evidence ?? []).find((item) => item.kind === 'executable' && item.exists === true);
  if (!executable) return null;
  if (client.id === 'codex') return { command: executable.path, rationale: 'Codex CLI 可否执行（--version）' };
  if (client.id === 'vscode') return { command: executable.path, rationale: 'VS Code CLI 可否执行（--version）' };
  if (client.id === 'cursor') return { command: executable.path, rationale: 'Cursor CLI 可否执行（--version）' };
  return null;
}

/**
 * 接入状态判定：已装 + 命中平台标记（或 DSH bundle 已安装）= 已接入；已装未命中 = 可接入；未装 = 未安装。
 * @param {Record<string, any>} record
 * @returns {string}
 */
export function decidePlatformState(record) {
  if (record.install_state !== INSTALL_STATE.INSTALLED) return PLATFORM_STATE.NOT_INSTALLED;
  if (record.platform?.bundle_installed === true) return PLATFORM_STATE.CONNECTED;
  if (Array.isArray(record.platform?.markers) && record.platform.markers.length > 0) return PLATFORM_STATE.CONNECTED;
  return PLATFORM_STATE.READY;
}

/**
 * 全量检测（**只读**；不创建、不修改任何文件）。
 * @param {{env?: Record<string, string|undefined>, home?: string, appdata?: string, localappdata?: string, pathValue?: string, now?: () => string}} [input]
 * @returns {Record<string, any>}
 */
export function detectAgents(input = {}) {
  const env = resolveEnv(input);
  const detected = [
    detectCodex(env),
    detectDeepSeekHarness(env),
    detectVsCode(env),
    detectClaudeDesktop(env),
    detectCursor(env),
    ...EXTENDED_CLIENT_IDS.map((id) => detectOtherClient(id, env)),
  ];
  /** @type {Array<Record<string, any>>} */
  const clients = detected.map((record) => {
    const platformState = decidePlatformState(record);
    return {
      ...record,
      install_state_label: INSTALL_STATE_LABEL[record.install_state],
      platform: { ...record.platform, status: platformState, status_label: PLATFORM_STATE_LABEL[platformState] },
    };
  });

  const primary = clients.filter((client) => PRIMARY_CLIENT_IDS.includes(client.id));
  const extended = clients.filter((client) => client.extended === true);
  const installCount = (state) => clients.filter((client) => client.install_state === state).length;
  const platformCount = (state) => clients.filter((client) => client.platform.status === state).length;

  return {
    schema: DETECT_SCHEMA,
    generated_at_utc: (input.now ?? (() => new Date().toISOString()))(),
    zero_write: true,
    read_only_note: '本工具只读：不创建、不修改任何文件；唯一可写的入口是显式 --out（仅限仓库内或系统临时目录）。',
    host: {
      home: env.home,
      appdata: env.appdata,
      localappdata: env.localappdata,
      path_entry_count: String(env.pathValue).split(path.delimiter).filter((item) => item.trim() !== '').length,
      platform: process.platform,
      node: process.versions.node,
    },
    repo: { root: REPO_ROOT, bundle_dir: path.join(REPO_ROOT, BUNDLE_DIRNAME), bundle_exists: fs.existsSync(path.join(REPO_ROOT, BUNDLE_DIRNAME)) },
    clients,
    primary_clients: primary.map((client) => client.id),
    extended_clients: extended.map((client) => client.id),
    summary: {
      clients_scanned: clients.length,
      installed: installCount(INSTALL_STATE.INSTALLED),
      residual_only: installCount(INSTALL_STATE.RESIDUAL_ONLY),
      not_detected: installCount(INSTALL_STATE.NOT_DETECTED),
      platform_connected: platformCount(PLATFORM_STATE.CONNECTED),
      platform_ready: platformCount(PLATFORM_STATE.READY),
      platform_not_installed: platformCount(PLATFORM_STATE.NOT_INSTALLED),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 接入动作（引用 bin/wrap-config.js 生成的片段，不重复造片段）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 用 wrap-config 的真实生成器产出一份示例片段（只用于「下一步该粘什么」）。
 * @param {ReturnType<typeof resolveEnv>} env
 * @param {string} [serverName]
 */
export function sampleWrapConfigs(env, serverName = 'mail') {
  const paths = resolveWrapPaths({ repoRoot: REPO_ROOT, env: { ...env.env, USERPROFILE: env.home, HOME: env.home, APPDATA: env.appdata } });
  const configs = buildConfigs({
    serverName,
    upstreamApp: 'mock-mail',
    upstreamCommand: process.execPath,
    upstreamArgs: ['src/mock_servers/mock_mail.js'],
    cwd: REPO_ROOT,
    runId: 'exp_detect_sample_YYYYMMDDTHHMMSS',
    db: 'demo-data/events.db',
    port: 8790,
    client: 'all',
    paths,
  });
  return { paths, configs };
}

/**
 * 每个客户端的具体接入动作（可复制；明确哪些步骤必须用户手动执行）。
 * @param {ReturnType<typeof detectAgents>} report
 * @param {ReturnType<typeof resolveEnv>} env
 * @returns {Array<{client: string, name: string, status: string, steps: Array<Record<string, any>>}>}
 */
export function buildActions(report, env) {
  const { paths, configs } = sampleWrapConfigs(env);
  const repoRel = (value) => normalizedPath(value);
  /** @type {Array<{client: string, name: string, status: string, steps: Array<Record<string, any>>}>} */
  const actions = [];
  for (const client of report.clients) {
    if (client.extended === true) continue;
    /** @type {Array<Record<string, any>>} */
    const steps = [];
    if (client.platform.status === PLATFORM_STATE.NOT_INSTALLED) {
      steps.push({
        title: '无需动作',
        detail: `未检测到 ${client.name} 的安装证据；本平台只在客户端存在时才能监控它（装好后再跑一次本命令即可）。`,
        requires_user: false,
      });
    } else if (client.platform.status === PLATFORM_STATE.CONNECTED) {
      const uniqueMarkers = [...new Set((client.platform.markers ?? []).map((hit) => hit.marker))];
      steps.push({
        title: '已接入，无需动作',
        detail: `已在本平台的 ${client.id} 配置里发现标记：${uniqueMarkers.join(', ') || '(DSH bundle 已安装)'}`,
        requires_user: false,
      });
      steps.push({
        title: '可选：核对实际挂载',
        detail: `在 ${client.name} 里调用一次工具（或看工具列表里是否出现 mcp__* 工具）。`,
        requires_user: true,
      });
    } else {
      if (client.id === 'codex') {
        steps.push({
          title: '取 Codex 片段（只打印，不写你的配置）',
          command: 'node bin\\wrap-config.js --client codex',
          detail: `把输出里的 [mcp_servers.*-trace] 片段**手动**追加到 ${repoRel(paths.codexConfig)}（含 .env 子表）。`,
          requires_user: true,
        });
        steps.push({ title: '或只读导入你现有的 Codex 配置生成清单', command: 'node bin\\setup.js --from-agent codex', detail: '只读，不修改 ~/.codex。', requires_user: false });
      } else if (client.id === 'deepseek_harness') {
        steps.push({
          title: '安装本仓库的 DSH bundle（必须用插件管理器；UI 操作）',
          detail: `侧栏「插件」→「添加插件」→ 填路径 ${repoRel(paths.bundleDir)}；bundle 是否已存在：${paths.bundleExists ? '是' : '否'}。直接往 profile patch 里 insert 会被静默跳过。`,
          requires_user: true,
        });
        steps.push({
          title: '安装后取 patch 片段（`- insert:` 形态）',
          command: 'node bin\\wrap-config.js --client dsh',
          detail: `粘到 profile patch（${configs.dsh.file}）之前先确认 bundle 已安装。`,
          requires_user: true,
        });
      } else if (client.id === 'vscode') {
        steps.push({
          title: '取 VS Code 的 JSON 片段（只打印，不创建文件）',
          command: 'node bin\\wrap-config.js --client vscode',
          detail: `把 {"servers":{…}} 合并进 ${repoRel(paths.vscodeMcpJson)}（该文件当前${client.config.exists ? '已存在' : '**不存在**，本工具不会替你创建'}）。`,
          requires_user: true,
        });
        steps.push({
          title: '或在 VS Code 内添加 MCP server',
          detail: 'VS Code → 命令面板 → “MCP: Add Server”（按提示填 command/args；值可直接照抄上一步片段）。',
          requires_user: true,
        });
      } else {
        const configPath = client.config.path;
        const snippet = JSON.stringify({ mcpServers: configs.vscode.json.servers }, null, 2);
        steps.push({
          title: `取 ${client.name} 的 mcpServers 片段（只打印）`,
          command: 'node bin\\wrap-config.js --client vscode',
          detail: `把片段里的 servers 内容改写成 mcpServers 形态后手动写入 ${repoRel(configPath)}：\n${snippet.split('\n').slice(0, 6).join('\n')}\n  …（完整片段见上一条命令的输出）`,
          requires_user: true,
        });
      }
    }
    actions.push({ client: client.id, name: client.name, status: client.platform.status, steps });
  }
  return actions;
}

// ─────────────────────────────────────────────────────────────────────────────
// 渲染与 CLI
// ─────────────────────────────────────────────────────────────────────────────

export const USAGE = `用法: node bin/detect-agents.js [选项]

只读扫描本机 MCP 客户端，回答一个问题：**这台机器上有哪些 agent 可以被监控、各自差哪一步**。
本命令**不写任何文件**（不创建 mcp.json、不改 ~/.codex / ~/.dsh / ~/.cursor）；显示面是浏览器页面（另见 bin/serve.js / bin/web.js）。

选项：
  --json                 输出机器可读 JSON（stdout）
  --out <path>           把输出写进指定文件。**只允许仓库内路径或系统临时目录**；用户配置目录一律拒绝（exit 2）
  --quiet                只打印表格与结论，不打印每个客户端的接入动作
  --home <dir>           覆盖用户目录（测试/夹具用；等价于改 USERPROFILE/HOME）
  --appdata <dir>        覆盖 %APPDATA%
  --localappdata <dir>   覆盖 %LOCALAPPDATA%
  --path <value>         覆盖 PATH（用于可执行文件**存在性**查找；测试/夹具用）
  --probe-cli            额外用「退出码」探测 code/codex/cursor（stdio=ignore：不抓输出，本工具不写文件）。
                         注意：这会启动**客户端自己的** CLI（带 --version），客户端 CLI 可能自行写它自己的
                         缓存/日志（不是本工具写的）；要求绝对零写入时请不要加这个开关。
  --help, -h             输出本说明并 exit 0（不扫描任何客户端）

检测状态：
  已安装 = 有强证据（可执行文件 / 安装目录 / 配置文件 / 配置目录）
  仅残留 = 只有日志、缓存或**其它产品**的目录（例如 %APPDATA%\\Cursor、~/.claude）
  未检测到 = 上述路径都不存在
接入状态：已接入（配置里出现本平台 Gateway 标记，或 DSH 已安装本仓库 bundle）/ 可接入 / 未安装

退出码：0 成功（没有可监控客户端也是 0）/ 2 用法错误`;

/** @param {string[]} argv */
export function parseArgs(argv) {
  const spec = {
    '--json': { type: 'boolean', key: 'json' },
    '--out': { type: 'string', key: 'out' },
    '--quiet': { type: 'boolean', key: 'quiet' },
    '--home': { type: 'string', key: 'home' },
    '--appdata': { type: 'string', key: 'appdata' },
    '--localappdata': { type: 'string', key: 'localappdata' },
    '--path': { type: 'string', key: 'pathValue' },
    '--probe-cli': { type: 'boolean', key: 'probeCli' },
    '--help': { type: 'boolean', key: 'help' },
    '-h': { type: 'boolean', key: 'help' },
  };
  const { values, positionals, help } = parseOptions(argv, spec, { allowPositionals: false });
  if (positionals.length > 0) throw new CliError(`未知位置参数：${positionals.join(' ')}`, 2, { showUsage: true });
  if (help) return { help: true };
  return {
    help: false,
    json: values.json === true,
    out: values.out,
    quiet: values.quiet === true,
    probeCli: values.probeCli === true,
    home: values.home,
    appdata: values.appdata,
    localappdata: values.localappdata,
    pathValue: values.pathValue,
  };
}

/**
 * `--out` 的安全解析：只允许仓库内或系统临时目录（**绝不**写用户配置目录）。
 * @param {string} target
 * @returns {string} 绝对路径
 */
export function resolveOutPath(target) {
  const resolved = path.resolve(target);
  if (isInsideRepo(resolved)) return resolved;
  const tempRoot = path.resolve(os.tmpdir());
  const relativeToTemp = path.relative(tempRoot, resolved);
  if (relativeToTemp !== '' && !relativeToTemp.startsWith('..') && !path.isAbsolute(relativeToTemp)) return resolved;
  throw new CliError(
    `--out 只允许写仓库内（${REPO_ROOT}）或系统临时目录（${tempRoot}）；用户配置目录一律拒绝：${resolved}`,
    2,
    { showUsage: true },
  );
}

/** @param {ReturnType<typeof detectAgents>} report @param {Array<Record<string, any>>} actions @param {boolean} quiet */
export function renderHumanReport(report, actions, quiet) {
  /** @type {string[]} */
  const lines = [];
  lines.push('=== 可监控 agent 自动检测（只读；本工具不写任何文件）===');
  lines.push(
    `主机：USERPROFILE=${report.host.home || '(未知)'}；APPDATA=${report.host.appdata || '(未知)'}；` +
      `PATH 条目=${report.host.path_entry_count}；node ${report.host.node}；bundle=${report.repo.bundle_exists ? '存在' : '缺失'}（${normalizedPath(report.repo.bundle_dir)}）`,
  );
  lines.push('');
  const columns = [
    { title: '客户端', key: 'name', width: 24 },
    { title: '安装', key: 'install', width: 8 },
    { title: '接入', key: 'platform', width: 8 },
    { title: '安装证据（路径 / 存在性）', key: 'evidence', width: 62 },
    { title: 'MCP 配置文件', key: 'config', width: 46 },
    { title: '条目', key: 'entries', width: 5, align: 'right' },
  ];
  const rows = report.clients
    .filter((client) => client.extended !== true)
    .map((client) => {
      const hit = client.install_evidence.find((item) => item.exists === true);
      const residualHit = (client.residual_evidence ?? []).find((item) => item.exists === true);
      const evidence = hit
        ? `${normalizedPath(hit.path)}（存在，${hit.kind}）${client.cli_probe ? `；CLI 探测 exit=${client.cli_probe.exit_code}` : ''}`
        : residualHit
          ? `仅残留：${normalizedPath(residualHit.path)}（存在，${residualHit.kind}）`
          : `未检测到（已查 ${client.install_evidence.length} 个候选路径）`;
      return {
        name: client.name,
        install: client.install_state_label,
        platform: client.platform.status_label,
        evidence,
        config: client.config.path ? `${normalizedPath(client.config.path)}${client.config.exists ? '' : '（不存在）'}` : '-',
        entries: client.config.entry_count,
      };
    });
  lines.push(renderTable(columns, rows));
  lines.push(
    `小结：扫描 ${report.summary.clients_scanned} 个客户端 —— 已安装 ${report.summary.installed}、仅残留 ${report.summary.residual_only}、未检测到 ${report.summary.not_detected}；` +
      `其中已接入本平台 ${report.summary.platform_connected}、可接入 ${report.summary.platform_ready}。`,
  );

  const extended = report.clients.filter((client) => client.extended === true && client.install_state !== INSTALL_STATE.NOT_DETECTED);
  lines.push('');
  lines.push(
    extended.length === 0
      ? `其它常见客户端（Windsurf / Zed / Continue / LM Studio）：均未检测到（候选路径都不存在）。`
      : `其它常见客户端：${extended.map((client) => `${client.name}=${client.install_state_label}`).join('、')}。`,
  );

  if (!quiet) {
    lines.push('');
    lines.push('── 下一步（按客户端给可复制动作；标「手动」的步骤必须你自己执行）──');
    for (const entry of actions) {
      lines.push(`■ ${entry.name}（${PLATFORM_STATE_LABEL[entry.status]}）`);
      entry.steps.forEach((step, index) => {
        lines.push(`  ${index + 1}) ${step.title}${step.requires_user ? ' ［手动］' : ''}`);
        if (step.command) lines.push(`     ${step.command}`);
        if (step.detail) {
          for (const detailLine of String(step.detail).split('\n')) lines.push(`     ${detailLine}`);
        }
      });
    }
    lines.push('');
    lines.push('提醒：本工具零写入；上面所有「手动」步骤都不会被本命令执行。接好后重跑本命令，接入列会变成「已接入」。');
    lines.push('显示面：**浏览器看板**（bin/serve.js 或 bin/web.js 起本地只读页面）；本命令只做「发现」，不启动任何服务、不打开任何页面。');
  }
  return lines.join('\n');
}

/**
 * 跑一次检测并返回人读文本/JSON（供 CLI 与测试共用）。
 * @param {Record<string, any>} options parseArgs 的返回
 * @param {{env?: Record<string, string|undefined>}} [context]
 * @returns {{report: Record<string, any>, actions: Array<Record<string, any>>, text: string, json: string}}
 */
export function runDetection(options, context = {}) {
  const env = resolveEnv({
    env: context.env ?? process.env,
    home: options.home,
    appdata: options.appdata,
    localappdata: options.localappdata,
    pathValue: options.pathValue,
  });
  const report = detectAgents({ env: env.env, home: env.home, appdata: env.appdata, localappdata: env.localappdata, pathValue: env.pathValue });
  const probed = options.probeCli === true
    ? { ...report, clients: attachCliProbes(report.clients, { runner: context.cliRunner }) }
    : report;
  const actions = buildActions(probed, env);
  const human = renderHumanReport(probed, actions, options.quiet === true);
  const payload = {
    ...probed,
    actions,
    wrap_config_reference: {
      generator: 'bin/wrap-config.js',
      clients: ['codex', 'dsh', 'vscode'],
      read_only_import: 'bin/setup.js --from-agent codex|dsh',
      notes: clientNotes(resolveWrapPaths({ repoRoot: REPO_ROOT, env: { ...env.env, USERPROFILE: env.home, HOME: env.home, APPDATA: env.appdata } })),
    },
  };
  return { report: probed, actions, text: human + '\n网关标记仅代表发现一个入口，不代表所有应用已覆盖。逐项检查：node tools/node.js bin/application-routing.js check\n', json: toJson(payload) };
}

async function main() {
  const argv = process.argv.slice(2);
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`[detect-agents] ${error.message}\n`);
      if (error.showUsage) process.stderr.write(`${USAGE}\n`);
      process.exit(error.exitCode);
    }
    throw error;
  }
  if (options.help) {
    stdoutLine(USAGE);
    process.exit(0);
  }

  try {
    const result = runDetection(options);
    const output = options.json ? result.json : result.text;
    if (options.out !== undefined) {
      const target = resolveOutPath(options.out);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${output}\n`, 'utf8');
      process.stderr.write(`[detect-agents] 已写入 ${target}（显式 --out：这是本命令唯一的写盘动作）\n`);
      // 写了文件就把人读报告打到 stderr，stdout 保持为空（便于 --out + 脚本使用）
      if (!options.json) process.stderr.write(`${result.text}\n`);
    } else {
      stdoutLine(output);
    }
    process.exit(0);
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`[detect-agents] ${error.message}\n`);
      if (error.showUsage) process.stderr.write(`${USAGE}\n`);
      process.exit(error.exitCode);
    }
    process.stderr.write(`[detect-agents] 运行失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  }
}

/** 直接运行本文件时执行；被 import（测试）时不执行。 */
const isEntry = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  await main();
}

export { HERE };
