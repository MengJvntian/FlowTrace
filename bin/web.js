#!/usr/bin/env node
/**
 * bin/web.js — P3 本地只读可视化服务入口（W1）
 *
 * 只做「参数解析 + 组装 + 退出码」，算法一律在 `src/web/`（CONVENTIONS §2）。
 *
 * 退出码：`0` 成功（含 `--help` / `--self-check` 通过）、`1` 运行期错误、`2` 用法错误。
 * 输出：服务 URL 与自检结果走 **stdout**；启动诊断与访问日志走 **stderr**。
 *
 * 只读性：本入口用 `openReadOnlyStore()`（SQLite `readOnly: true`）打开事件库，
 * 库文件不存在时**不创建**文件，只把「原始数据采集：已删除」如实显示在页面上。
 */
import http from 'node:http';
import net from 'node:net';
import process from 'node:process';
import { WEB_USAGE, WebConfigError, describeWebConfig, resolveWebConfig } from '../src/web/config.js';
import { createWebServer } from '../src/web/index.js';

/** @param {string} line */
function err(line) {
  process.stderr.write(`${line}\n`);
}

/**
 * @returns {Promise<number>} 退出码
 */
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(WEB_USAGE);
    return 0;
  }

  /** @type {Record<string, any>} */
  let config;
  try {
    config = resolveWebConfig(argv, process.env);
  } catch (error) {
    if (error instanceof WebConfigError) {
      err(`[web] 用法错误：${error.message}`);
      err('');
      err(WEB_USAGE);
      return error.exitCode ?? 2;
    }
    throw error;
  }

  const web = createWebServer({
    config,
    logger: (line) => {
      if (!config.quiet) err(`[web] ${line}`);
    },
    // t43：单独跑 web.js 时没有 serve 的生命周期管理，明确标成 keep-alive（页面会照实显示）
    lifecycle: { mode: 'keep-alive', idle_timeout_seconds: null },
    // 心跳回调：只有开了 `--self-exit-when-idle` 才用它计时（见下面的说明）。
    onAlive: (nowIso) => {
      lastAliveMs = Date.now();
      sawFirstHeartbeat = true;
      void nowIso;
    },
  });

  let info;
  try {
    info = await web.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    err(`[web] 启动失败：${message}`);
    if (/EADDRINUSE/i.test(message)) err(`[web] 端口 ${config.port} 已被占用；换 --port 或先停掉旧进程。`);
    web.closeStore();
    return 1;
  }

  err(`[web] 配置：${describeWebConfig(config)}`);
  err(`[web] 监听：${info.address.address ?? config.host}:${info.port}（证据只读；本机应用中心可保存监控模式）`);
  err(`[web] 采集状态：${info.collection.label} — ${info.collection.detail}`);
  if (!info.collection.db_exists) {
    err('[web] 提示：事件库文件不存在，页面会显示「原始数据采集：已删除」；本服务不会创建库文件。');
  }
  if (config.allowRaw) {
    err('[web] 受控查看原文：开启（每次访问写入内存审计记录；页面「审计记录」区可读）');
  } else {
    err('[web] 受控查看原文：已关闭（--no-raw-access）');
  }
  process.stdout.write(`${info.url}\n`);

  if (config.selfCheck) {
    const exitCode = await runSelfCheck(web, info, config);
    await web.close();
    web.closeStore();
    return exitCode;
  }

  /** @type {Promise<number>} */
  return new Promise((resolve) => {
    const shutdown = (signal) => {
      err(`[web] 收到 ${signal}，关闭只读服务…`);
      web.close().then(() => {
        web.closeStore();
        resolve(0);
      });
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    // ── 空闲自退（`--self-exit-when-idle[=<秒>]`）──────────────────────────────
    // 为什么必须有它（2026-10-07 用户实际卡住的死循环）：
    //   serve 的复用分支会把页面服务以 **detached 子进程**拉起，并且只通过 stop-file 收尾。
    //   一旦 manager 自己先退出（崩溃/被杀/沙箱回收），这个页面子进程就成了**孤儿**：
    //   它永远占着 8787、没有任何东西能停它 —— 于是
    //     stop 说「没有在运行」、start 说「正在运行，复用它」、打开却没有数据（没有网关）。
    //   打开本开关后，页面在**收到过第一次心跳**之后开始计时，心跳超过阈值即自行退出。
    //   刻意要求「先有过心跳」：否则刚起好、你还没打开浏览器时它就会把自己判成空闲而退出。
    const idleSeconds = config.selfExitWhenIdleSeconds;
    if (Number.isFinite(idleSeconds) && idleSeconds > 0) {
      err(`[web] 空闲自退：开启——页面停止汇报心跳后 ${idleSeconds} 秒内自行退出`);
      selfExitTimer = setInterval(() => {
        if (!sawFirstHeartbeat) return; // 还没人打开过页面 → 不算空闲
        const idleMs = Date.now() - lastAliveMs;
        if (idleMs < idleSeconds * 1000) return;
        err(`[web] 页面已停止汇报心跳 ${Math.round(idleMs / 1000)} 秒（阈值 ${idleSeconds} 秒），自行退出。`);
        err('[web] 这样可以避免留下一个没人管、又占着端口的孤儿页面进程。');
        shutdown('idle-timeout');
      }, Math.min(10_000, Math.max(1000, Math.round((idleSeconds * 1000) / 4))));
      if (typeof selfExitTimer.unref === 'function') selfExitTimer.unref();
    }
  });
}

/** 最近一次心跳时间（毫秒）。仅在开启空闲自退时被读取。 */
let lastAliveMs = Date.now();
/** 是否已经收到过至少一次心跳——避免「刚起好还没人打开」就被判为空闲。 */
let sawFirstHeartbeat = false;
/** 空闲自退的轮询定时器。 */
let selfExitTimer = null;

/**
 * 最小 HTTP 客户端（用 `node:http` 而不是 fetch：自检需要能自定义 `Host` 头来验证 DNS rebinding 防护）。
 * @param {string} url
 * @param {{method?: string, headers?: Record<string, string>, body?: string}} [options]
 * @returns {Promise<{status: number, headers: Record<string, any>, body: string, json: any}>}
 */
function request(url, options = {}) {
  const method = options.method ?? 'GET';
  const body = options.body ?? null;
  return new Promise((resolve, reject) => {
    const headers = { ...(options.headers ?? {}) };
    if (body !== null) headers['Content-Length'] = String(Buffer.byteLength(body, 'utf8'));
    const req = http.request(url, { method, headers }, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, json: parsed });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

/**
 * 原始 socket HTTP 探测：**手工拼请求行与请求头**，不经过任何 HTTP 客户端库。
 *
 * 为什么必须这样：`fetch`（undici）与部分 HTTP 客户端**不允许覆盖 `Host` 头**（undici 直接忽略），
 * 于是「Host: evil.example.com → 403」这类断言会被默默退化成「普通回环请求 → 200」，
 * 看起来通过了但根本没触发被测代码。用 `node:net` 手写请求字节可以绕开这层规范化，
 * 断言的是服务端真实收到的请求（并把原始字节写进自检报告，供任何人独立复核）。
 *
 * @param {number} port
 * @param {{hostHeader: string, path?: string, method?: string, extraHeaders?: string[]}} options
 * @returns {Promise<{request_bytes: string, response_bytes: string, status_line: string, status: number}>}
 */
function rawHttpProbe(port, options) {
  const method = options.method ?? 'GET';
  const target = options.path ?? '/api/meta';
  const headerLines = [
    `${method} ${target} HTTP/1.1`,
    `Host: ${options.hostHeader}`,
    'Accept: application/json',
    'Connection: close',
    ...(options.extraHeaders ?? []),
  ];
  const requestBytes = `${headerLines.join('\r\n')}\r\n\r\n`;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write(requestBytes);
    });
    /** @type {Buffer[]} */
    const chunks = [];
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error('原始 socket 探测超时（5s）'));
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => {
      const responseBytes = Buffer.concat(chunks).toString('utf8');
      const statusLine = responseBytes.split('\r\n')[0] ?? '';
      const match = /^HTTP\/1\.[01] (\d{3})/u.exec(statusLine);
      resolve({
        request_bytes: requestBytes,
        response_bytes: responseBytes,
        status_line: statusLine,
        status: match ? Number(match[1]) : 0,
      });
    });
    socket.on('error', reject);
  });
}

/**
 * 自检：对**真实监听的 HTTP 服务**发同源请求，逐项断言只读 API 的结构与隐私边界。
 *
 * 这是沙箱内可复现的端到端验收（不依赖父子进程管道 stdio：服务与请求在同一个进程里完成，
 * 走的是真实 socket 与真实 HTTP 解析）。它**不**声称验证了「真实客户端经 Gateway 调用」，
 * 那一项属于沙箱外待用户执行（相关实现 的 B1–B4 与 §9）。
 *
 * @param {Record<string, any>} web
 * @param {{url: string, port: number, address: Record<string, any>}} info
 * @param {Record<string, any>} config
 * @returns {Promise<number>}
 */
async function runSelfCheck(web, info, config) {
  const base = `http://127.0.0.1:${info.port}`;
  /** @type {Array<{name: string, ok: boolean, detail: string, raw_probe?: Record<string, any>}>} */
  const checks = [];

  /**
   * @param {string} name
   * @param {() => Promise<{ok: boolean, detail: string, raw_probe?: Record<string, any>}>} fn
   */
  async function check(name, fn) {
    try {
      const result = await fn();
      checks.push({ name, ok: result.ok, detail: result.detail, ...(result.raw_probe ? { raw_probe: result.raw_probe } : {}) });
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  await check('loopback_only', async () => {
    const address = info.address.address;
    return { ok: address === '127.0.0.1', detail: `bind address = ${address}` };
  });

  await check('page_html', async () => {
    const response = await request(`${base}/`);
    return {
      ok: response.status === 200 && response.body.includes('本地只读可视化') && response.body.includes('流向图'),
      detail: `HTTP ${response.status}, ${response.body.length} bytes, content-type=${response.headers['content-type']}`,
    };
  });

  await check('assets', async () => {
    const js = await request(`${base}/app.js`);
    const css = await request(`${base}/styles.css`);
    return { ok: js.status === 200 && css.status === 200, detail: `app.js ${js.status}, styles.css ${css.status}` };
  });

  /** @type {Record<string, any>} */
  let meta = null;
  await check('api_meta', async () => {
    const response = await request(`${base}/api/meta`);
    meta = response.json;
    return {
      ok:
        response.status === 200 &&
        meta?.ok === true &&
        meta?.service?.read_only === true &&
        Array.isArray(meta?.service?.write_endpoints) &&
        meta.service.write_endpoints.length === 0,
      detail: `collection=${meta?.collection?.state}, registered=${meta?.run_root?.registered?.count}, implicit=${meta?.run_root?.implicit?.count}, methods=${(meta?.service?.allowed_methods ?? []).join('/')}`,
    };
  });

  await check('read_only_methods', async () => {
    const response = await request(`${base}/api/runs`, { method: 'POST', body: '{}' });
    return {
      ok: response.status === 405 && response.json?.error?.code === 'read_only',
      detail: `POST /api/runs → HTTP ${response.status} (${response.json?.error?.code ?? '?'}, Allow=${response.headers.allow ?? '-'})`,
    };
  });

  await check('page_layering', async () => {
    // 用户要求「首页只呈现关键信息、不显示系统信息」：这里对**真实服务**抓首页/次级页来验证层级，
    // 而不是只信源码。首页静态文本里出现任何系统/运维词汇即失败；同时必须给出显式次级入口。
    // t43：把新增的 `/filters.js` 也纳入扫描（它和首页共用同一份筛选逻辑，同样不得泄漏系统词汇）。
    // t46：再加三项首屏密度不变量（用户反馈「信息密集」）：
    //   ① 筛选面板随页面就发成**折叠**状态（不靠 JS 才折叠，否则首屏第一帧仍是控件堆叠）；
    //   ② 折叠开关存在且 `aria-expanded="false"`（键盘/读屏可达，不是纯样式隐藏）；
    //   ③ 页面标题与 `<h1>` 不再逐字重复（此前 `<title>` 与 `<h1>` 同串，测可见文本时会数两遍）。
    const home = await request(`${base}/`);
    const appJs = await request(`${base}/app.js`);
    const commonJs = await request(`${base}/common.js`);
    const filtersJs = await request(`${base}/filters.js`);
    const isrJs = await request(`${base}/isr.js`);
    const css = await request(`${base}/styles.css`);
    const ops = await request(`${base}/ops.html`);
    const systemMarkers = ['db_path', 'journal_mode', 'schema_version', 'read_only', 'REGISTERED', '库路径', '保留期', '审计记录', '采集状态', 'collection'];
    const leaked = [];
    for (const marker of systemMarkers) {
      if (home.body.includes(marker)) leaked.push(`/:${marker}`);
      if (appJs.body.includes(marker)) leaked.push(`/app.js:${marker}`);
      if (commonJs.body.includes(marker)) leaked.push(`/common.js:${marker}`);
      if (filtersJs.body.includes(marker)) leaked.push(`/filters.js:${marker}`);
      if (isrJs.body.includes(marker)) leaked.push(`/isr.js:${marker}`);
    }
    const hasEntry = home.body.includes('href="/ops.html"');

    const panelTag = /<section[^>]*id="filter-panel"[^>]*>/u.exec(home.body)?.[0] ?? '';
    const panelCollapsed = /\shidden(?:\s|>)/u.test(panelTag);
    const toggleTag = /<button[^>]*id="toggle-filters"[^>]*>/u.exec(home.body)?.[0] ?? '';
    const toggleDeclaredCollapsed = /aria-expanded="false"/u.test(toggleTag);
    const titleText = (/<title[^>]*>([\s\S]*?)<\/title>/u.exec(home.body)?.[1] ?? '').trim();
    const headingText = (/<h1[^>]*>([\s\S]*?)<\/h1>/u.exec(home.body)?.[1] ?? '').trim();
    const titleDistinct = titleText !== '' && headingText !== '' && titleText !== headingText;
    const hasDisclosure = home.body.includes('<details');
    const hasDarkMode = css.body.includes('prefers-color-scheme');
    // 功能 A（自动刷新）：默认开启的开关 + 只在可见时轮询的决策模块，缺一即失败。
    const autoRefreshTag = /<input[^>]*id="auto-refresh-enabled"[^>]*>/u.exec(home.body)?.[0] ?? '';
    const autoRefreshDefaultOn = autoRefreshTag.includes('checked');
    const autoRefreshWired =
      appJs.body.includes("addEventListener('visibilitychange'") &&
      appJs.body.includes('document.visibilityState') &&
      isrJs.body.includes('DEFAULT_INTERVAL_SECONDS = 5') &&
      isrJs.body.includes('INTERVAL_CHOICES_SECONDS = [5, 10, 30]');

    return {
      ok:
        home.status === 200 &&
        ops.status === 200 &&
        appJs.status === 200 &&
        filtersJs.status === 200 &&
        isrJs.status === 200 &&
        css.status === 200 &&
        hasEntry &&
        leaked.length === 0 &&
        panelCollapsed &&
        toggleDeclaredCollapsed &&
        titleDistinct &&
        hasDisclosure &&
        hasDarkMode &&
        autoRefreshDefaultOn &&
        autoRefreshWired,
      detail:
        `首页 HTTP ${home.status}、次级页 HTTP ${ops.status}、次级入口 ${hasEntry ? '有' : '缺失'}、` +
        `filters.js HTTP ${filtersJs.status}、isr.js HTTP ${isrJs.status}、` +
        `首页系统标记泄漏 ${leaked.length === 0 ? '无' : JSON.stringify(leaked)}；` +
        `首屏密度：筛选面板默认折叠 ${panelCollapsed ? '是' : '否'}、` +
        `开关声明 aria-expanded=false ${toggleDeclaredCollapsed ? '是' : '否'}、` +
        `标题与 h1 不重复 ${titleDistinct ? '是' : '否'}、渐进披露 ${hasDisclosure ? '有' : '缺失'}、` +
        `深色模式支持 ${hasDarkMode ? '有' : '缺失'}；` +
        `自动刷新：默认开启 ${autoRefreshDefaultOn ? '是' : '否'}、` +
        `可见性暂停 + 默认 5 秒档 ${autoRefreshWired ? '已接线' : '缺失'}`,
    };
  });

  await check('host_guard_raw_socket', async () => {
    // 用原始 socket 手工写入 `Host: evil.example.com`：HTTP 客户端库会（静默）忽略该覆盖，
    // 因此必须绕开它们，断言服务端真实收到的请求。
    const hostile = await rawHttpProbe(info.port, { hostHeader: 'evil.example.com' });
    const control = await rawHttpProbe(info.port, { hostHeader: `127.0.0.1:${info.port}` });
    const lanHost = await rawHttpProbe(info.port, { hostHeader: '192.168.1.50' });
    const hostileBlocked = hostile.status === 403 && hostile.response_bytes.includes('forbidden_host');
    const lanBlocked = lanHost.status === 403;
    const controlOk = control.status === 200;
    return {
      ok: hostileBlocked && lanBlocked && controlOk,
      detail:
        `raw socket: Host=evil.example.com → ${hostile.status_line}; Host=192.168.1.50 → ${lanHost.status_line}; ` +
        `正向对照 Host=127.0.0.1:${info.port} → ${control.status_line}（证明探测本身有效）`,
      raw_probe: {
        probe: 'node:net 手工拼接请求行/请求头（不经 HTTP 客户端库，避免 Host 被规范化忽略）',
        negative_host_example_com: hostile,
        negative_host_lan_ip: lanHost,
        positive_control_loopback: control,
      },
    };
  });

  /** @type {Array<Record<string, any>>} */
  let runs = [];
  await check('api_runs', async () => {
    const response = await request(`${base}/api/runs?retention=all`);
    runs = response.json?.runs ?? [];
    return {
      ok: response.status === 200 && response.json?.ok === true && typeof response.json?.run_root?.registered?.count === 'number',
      detail: `runs=${runs.length}, registered=${response.json?.run_root?.registered?.count}, implicit=${response.json?.run_root?.implicit?.count}`,
    };
  });

  const sample = runs.find((run) => run.call_count > 0) ?? runs[0] ?? null;
  if (sample !== null) {
    const runKey = sample.experiment_run_id ?? sample.run_id;
    await check('api_timeline', async () => {
      const response = await request(`${base}/api/runs/${encodeURIComponent(runKey)}/timeline`);
      const pairing = response.json?.pairing;
      return {
        ok: response.status === 200 && response.json?.ok === true && typeof pairing?.complete === 'boolean',
        detail: `calls_checked=${pairing?.calls_checked}, ok=${pairing?.ok}, incomplete=${pairing?.incomplete?.length}, complete=${pairing?.complete}`,
      };
    });
    await check('api_flows', async () => {
      const response = await request(`${base}/api/runs/${encodeURIComponent(runKey)}/flows`);
      const boundaries = response.json?.boundaries ?? [];
      return {
        ok: response.status === 200 && response.json?.ok === true && boundaries.length === 4,
        detail: `boundaries=${boundaries.map((boundary) => boundary.key).join(',')}, observed=${response.json?.edges?.observed?.length}, inferred=${response.json?.edges?.inferred?.length}`,
      };
    });
    await check('raw_requires_gate', async () => {
      const flows = (await request(`${base}/api/runs/${encodeURIComponent(runKey)}/flows`)).json;
      const edge = [...(flows?.edges?.observed ?? []), ...(flows?.edges?.inferred ?? [])][0];
      if (!edge) return { ok: true, detail: '该运行没有边，跳过（受控访问门禁由 tests/web_api.test.js 覆盖）' };
      const noAck = await request(`${base}${edge.raw_access.source_url}`);
      const noReason = await request(`${base}${edge.raw_access.source_url}&ack=1`);
      const gated = await request(`${base}${edge.raw_access.source_url}&ack=1&reason=self-check`);
      return {
        ok: noAck.status === (config.maskData ? 400 : 200) && noReason.status === (config.maskData ? 400 : 200) && gated.status === 200,
        detail: `无 ack → ${noAck.status}, 无理由 → ${noReason.status}, 合规 → ${gated.status}`,
      };
    });
    await check('audit_recorded', async () => {
      const response = await request(`${base}/api/audit`);
      return {
        ok: response.json?.ok === true && typeof response.json?.summary?.count === 'number',
        detail: `audit entries=${response.json?.summary?.count}, persisted=${response.json?.summary?.persisted}`,
      };
    });
    await check('export_masked_default', async () => {
      const response = await request(`${base}/api/runs/${encodeURIComponent(runKey)}/export?format=json`);
      return {
        ok: response.status === 200 && response.json?.masked === (config.maskData === true) && response.json?.schema_version !== undefined,
        detail: `masked=${response.json?.masked}, calls=${response.json?.counts?.calls}, events=${response.json?.counts?.events}`,
      };
    });
  } else {
    checks.push({ name: 'run_scoped_checks', ok: true, detail: '库里没有运行（或库不存在），跳过运行级检查' });
  }

  await check('audit_log_empty_default', async () => {
    const response = await request(`${base}/api/audit`);
    return {
      ok: response.status === 200 && response.json?.summary?.persisted === false,
      detail: `records=${response.json?.summary?.count}（审计只在内存，不落盘）`,
    };
  });

  const failed = checks.filter((entry) => !entry.ok);
  const report = {
    self_check: true,
    url: info.url,
    bind_address: info.address.address ?? null,
    config: { db: config.dbPath, retention_days: config.retentionDays, allow_raw: config.allowRaw, preview_chars: config.previewChars },
    checks,
    failed: failed.length,
    all_ok: failed.length === 0,
    boundary_statement:
      '自检覆盖「服务真实监听 + 真实 HTTP 请求 + 只读/隐私门禁」；不覆盖「真实 MCP 客户端经 Gateway 的调用链路」，' +
      '应用连接须在实际客户端中通过受管路由使用。',
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.all_ok ? 0 : 1;
}

process.exitCode = await main();
