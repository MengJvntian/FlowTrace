/**
 * src/web/index.js — P3 只读页面（W1）统一出口
 *
 * 用法（`bin/web.js` 是唯一的启动入口）：
 * ```js
 * import { resolveWebConfig, createWebServer } from './src/web/index.js';
 * const config = resolveWebConfig(process.argv.slice(2), process.env);
 * const web = createWebServer({ config });
 * const info = await web.start();     // info.url → http://127.0.0.1:8787/
 * ```
 *
 * 模块分工：
 *   config.js     参数/环境变量、默认值与校验（含回环限制）
 *   readonly.js   只读 SQLite 连接 + 查询白名单门面（只读边界）
 *   aggregate.js  运行聚合（登记 vs 隐式）、配对判定、采集状态、UTC/本地时间
 *   edges.js      L1 血缘结果的展示投影：四种边界、边、候选、证据回溯
 *   mask.js       展示层脱敏（键名 + 值模式 + 密钥 + 预览上限）
 *   audit.js      受控查看原文的审计记录（内存环形缓冲）
 *   api.js        只读 JSON API
 *   static.js     白名单静态资源（无构建链）
 *   server.js     HTTP 服务（GET/HEAD、Host 校验、安全响应头）
 */
export {
  DEFAULT_AUDIT_MAX,
  DEFAULT_DB_RELATIVE,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_PREVIEW_CHARS,
  DEFAULT_RETENTION_DAYS,
  LOOPBACK_HOSTS,
  MIN_REVEAL_REASON_LENGTH,
  RETENTION_MODES,
  WEB_USAGE,
  WebConfigError,
  describeWebConfig,
  isLoopbackHost,
  normalizeHost,
  parseWebOptions,
  resolveDbPath,
  resolveWebConfig,
} from './config.js';

export {
  READONLY_METHODS,
  WRITE_METHODS,
  asReadOnlyStore,
  openReadOnlyStore,
  openWebStore,
} from './readonly.js';

export {
  COLLECTION_STATES,
  UNASSIGNED,
  buildRunTimeline,
  collectRunAggregates,
  collectionStatus,
  formatUtcLocal,
  pairingOfCalls,
  runKeyOf,
  timezoneInfo,
} from './aggregate.js';

export {
  BOUNDARY_DEFINITIONS,
  BOUNDARY_KEYS,
  METRIC_DISCLAIMER,
  buildRunFlows,
  edgeIdOf,
  leafKeyOf,
  rawAccessUrl,
} from './edges.js';

export {
  MASK_MODE,
  SECRET_PLACEHOLDER,
  classifyKey,
  isSecretKey,
  maskPolicy,
  maskSensitiveString,
  maskTextValue,
  maskValue,
  newMaskStats,
  scanSensitive,
} from './mask.js';

export { AUDIT_ACTIONS, AuditLog } from './audit.js';

export {
  API_PREFIX,
  ApiError,
  apiAudit,
  apiEdgeDetail,
  apiExport,
  apiFlows,
  apiMeta,
  apiOps,
  apiRaw,
  apiRun,
  apiRuns,
  apiTimeline,
  requireReveal,
  resolvePath,
  runRootCounts,
} from './api.js';

export { STATIC_FILES, readStatic, staticDir } from './static.js';

export { createWebServer, handleRequest, hostnameOf } from './server.js';
