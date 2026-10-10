/* src/web/public/isr.js — 首页「自动刷新」的**纯逻辑**（无 DOM、无请求、无定时器、无依赖）
 *
 * 为什么单独成文件（和 filters.js 同样的理由）：
 *   「自动刷新」是用户明确要求的功能，但它的大部分风险不在「定时器能不能跑」，
 *   而在几条**行为契约**：同一时刻只允许一个在途请求、页面不可见时不轮询、
 *   失败不静默且自动退避重试。把这些决策写成纯函数/纯状态机，测试就能用 `node:vm`
 *   加载**同一个文件**直接断言这些契约（沙箱里没有浏览器，交互级无法验证）。
 *   页面侧（app.js）只负责：接线、发请求、渲染状态文案——决策一律来自本文件。
 *
 * 只读语义不变：本文件**不发任何请求**、不碰 DOM、不认识任何接口；它只回答
 * 「现在这一拍该不该请求、该隔多久请求下一拍」。
 *
 * 约定（与 server.js 的 CSP 一致）：经典脚本、无内联事件处理器、无第三方依赖、无构建链。
 */
(function (root) {
  'use strict';

  /** 自动刷新的默认间隔（秒）。用户要求「默认开启、间隔建议 5 秒」。 */
  var DEFAULT_INTERVAL_SECONDS = 5;

  /** 可选的间隔档位（秒）：小档看实时性，大档省请求。 */
  var INTERVAL_CHOICES_SECONDS = [5, 10, 30];

  /**
   * 一次手动/自动请求的单次超时保护（毫秒）。
   * 超过这个时间就 abort 并**按失败处理**（不清空页面、进入退避重试），
   * 而不是让一次卡住的请求把后续所有轮询都堵在「在途」状态里。
   */
  var REQUEST_TIMEOUT_MS = 8000;

  /** 连续失败时的退避倍数：连续失败越多，重试越稀（1 次失败 → 3 倍间隔，2 次及以上 → 12 倍，上限 60 秒）。 */
  var BACKOFF_FACTOR = 3;
  var BACKOFF_FACTOR_MAX = 12;
  var BACKOFF_CAP_SECONDS = 60;

  /** 界面文案（给人看的中文，不出现任何系统/运维词汇）。 */
  var MESSAGES = {
    running: '自动刷新：每 {seconds} 秒',
    paused_hidden: '自动刷新：页面在后台，已暂停',
    paused_failed: '自动刷新失败，将重试（约 {seconds} 秒后）',
    off: '自动刷新：已关闭',
    manual: '自动刷新：已暂停',
  };

  /**
   * 一个间隔值是否可用：数字、有限、在 1~600 秒之间。
   * 非法值一律**回落**到默认档（而不是变成 0 或 NaN 造成忙轮询/永不触发）。
   * @param {*} seconds
   * @returns {boolean}
   */
  function isIntervalSeconds(seconds) {
    var value = Number(seconds);
    return Number.isFinite(value) && value >= 1 && value <= 600;
  }

  /**
   * @param {*} seconds
   * @returns {number} 合法的间隔秒数（非法 → 默认 5 秒）
   */
  function normalizeIntervalSeconds(seconds) {
    return isIntervalSeconds(seconds) ? Number(seconds) : DEFAULT_INTERVAL_SECONDS;
  }

  /**
   * 轮询调度器（**纯决策**）。宿主（app.js）负责完成后 setTimeout、发请求与渲染。
   *
   * 契约（每条都有测试盯着）：
   *   1) 开关关闭 → 永不触发；在途标记仅由请求完成或失败释放；
   *   2) 页面不可见 → 永不触发；`setVisible(true)` 只是**恢复**轮询，立即刷一次由页面调用 `check()`；
   *   3) 同一时刻只允许一个在途请求：`begin()` 已置位时再 `tick()` 直接跳过（计入 `skipped`，不排队、不堆积）；
   *   4) 失败 → **不关闭开关**（用户的开关状态不被改写），进入退避：下一拍延到 3/12 倍间隔（上限 60 秒）；
   *   5) 任一次成功 → 立即恢复正常间隔（恢复后自动继续）。
   *
   * @param {{refresh: () => Promise<any>, intervalSeconds?: number, enabled?: boolean, visible?: boolean}} options
   * @returns {Record<string, any>}
   */
  function createScheduler(options) {
    var config = options || {};
    var refresh = config.refresh;
    if (typeof refresh !== 'function') throw new TypeError('createScheduler 需要 refresh 函数（要执行的那次刷新）');

    var intervalSeconds = normalizeIntervalSeconds(config.intervalSeconds);
    var enabled = config.enabled !== false;
    var visible = config.visible !== false;
    var inFlight = false;
    var success = true;
    var failures = 0;
    var ticks = 0;
    var skipped = 0;
    var lastError = null;

    /** 当前这一拍的间隔（秒）：失败退避、可见性与开关各自独立参与判断。 */
    function delaySeconds() {
      var base = intervalSeconds;
      if (failures <= 0) return base;
      var factor = failures === 1 ? BACKOFF_FACTOR : BACKOFF_FACTOR_MAX;
      return Math.min(base * factor, BACKOFF_CAP_SECONDS);
    }

    /** 当前是否处于「会继续轮询」的状态（开关开着 + 页面可见）。 */
    function isRunning() {
      return enabled && visible;
    }

    /**
     * 执行一拍。
     * @returns {Promise<{ran: boolean, ok?: boolean, skipped?: string, error?: Error|null}>}
     */
    function tick(manual) {
      if (manual !== true && !isRunning()) return Promise.resolve({ ran: false, skipped: enabled ? 'hidden' : 'off' });
      // 前一次还没回来就跳过这一轮（不并发、不排队、不堆积）
      if (inFlight) {
        skipped += 1;
        return Promise.resolve({ ran: false, skipped: 'in-flight' });
      }
      inFlight = true;
      ticks += 1;
      return Promise.resolve()
        .then(function () { return refresh(manual === true); })
        .then(function () {
          inFlight = false;
          success = true;
          failures = 0;
          lastError = null;
          return { ran: true, ok: true, error: null };
        }, function (error) {
          inFlight = false;
          success = false;
          failures += 1;
          lastError = error || new Error('未知失败');
          return { ran: true, ok: false, error: lastError };
        });
    }

    return {
      /** @param {boolean} next */
      setEnabled: function (next) {
        enabled = next !== false;
        return enabled;
      },
      /** 是否「开着」（用户的意图，不会因为一次失败被改写）。 */
      isEnabled: function () { return enabled; },
      /** @param {boolean} next */
      setVisible: function (next) {
        visible = next !== false;
        return visible;
      },
      isVisible: function () { return visible; },
      /** 用户改间隔：只影响下一拍，在途请求不受影响。 @param {*} seconds */
      setIntervalSeconds: function (seconds) {
        intervalSeconds = normalizeIntervalSeconds(seconds);
        return intervalSeconds;
      },
      intervalSeconds: function () { return intervalSeconds; },
      /** 标记一拍开始（页面在发请求前调用；返回 false 表示这一拍被跳过）。 */
      begin: function () {
        if (!isRunning() || inFlight) return false;
        inFlight = true;
        ticks += 1;
        return true;
      },
      /** 标记一拍成功：清错误、清退避。 */
      finish: function () {
        inFlight = false;
        success = true;
        failures = 0;
        lastError = null;
        return true;
      },
      /** 标记一拍失败：**不改开关**，只进入退避。 @param {Error} [error] */
      fail: function (error) {
        inFlight = false;
        success = false;
        failures += 1;
        lastError = error || new Error('未知失败');
        return failures;
      },
      nextDelay: function () { return delaySeconds(); },
      inFlight: function () { return inFlight; },
      isRunning: isRunning,
      /** 只读快照：页面每次渲染状态文案前取一次。 */
      snapshot: function () {
        return {
          enabled: enabled,
          visible: visible,
          inFlight: inFlight,
          success: success,
          failures: failures,
          intervalSeconds: delaySeconds(),
          baseIntervalSeconds: intervalSeconds,
          ticks: ticks,
          skipped: skipped,
          lastError: lastError,
        };
      },
      tick: tick,
    };
  }

  /**
   * 调度器状态 → 页面上的**一行小字**（纯函数，便于断言「失败可辨识、不静默」）。
   * 三种状态各有独立文案：正常运行 / 页面在后台已暂停 / 失败退避重试中 / 已关闭。
   * @param {Record<string, any>} snapshot createScheduler().snapshot() 的结果
   * @returns {{text: string, state: 'off'|'hidden'|'retry'|'running', failed: boolean}}
   */
  function presentation(snapshot) {
    var state = snapshot || {};
    var seconds = isIntervalSeconds(state.intervalSeconds) ? Number(state.intervalSeconds) : DEFAULT_INTERVAL_SECONDS;
    var render = function (key) {
      return MESSAGES[key].replace('{seconds}', String(seconds));
    };
    if (state.enabled === false) {
      var manualFailed = state.success === false;
      var manualReason = state.lastError && state.lastError.message ? String(state.lastError.message).slice(0, 120) : '读取失败';
      return { text: MESSAGES.off + (manualFailed ? '｜刷新失败：' + manualReason : ''), state: 'off', failed: manualFailed };
    }
    if (state.visible === false) return { text: MESSAGES.paused_hidden, state: 'hidden', failed: false };
    if (state.success === false) {
      // 失败必须**可辨识**：只说「自动刷新失败」等于没说 —— 用户无法区分是服务停了、
      // 请求超时、还是某个接口 404。这里把调度器记下的最后一条错误原因带上
      // （2026-10-05：用户报「老是报自动刷新失败」时，旧文案给不出任何线索）。
      var base = render('paused_failed');
      var reason = state.lastError && state.lastError.message ? String(state.lastError.message) : '';
      if (reason !== '') {
        // 原因可能很长（fetch 的错误串可以几百字符），截断避免把工具条撑爆
        var short = reason.length > 120 ? reason.slice(0, 117) + '…' : reason;
        return { text: base + '｜原因：' + short, state: 'retry', failed: true, reason: reason };
      }
      return { text: base, state: 'retry', failed: true, reason: null };
    }
    if (state.inFlight === true) return { text: '自动刷新进行中…', state: 'running', failed: false };
    return { text: render('running'), state: 'running', failed: false };
  }

  root.TraceUI = root.TraceUI || {};
  root.TraceUI.isr = {
    DEFAULT_INTERVAL_SECONDS: DEFAULT_INTERVAL_SECONDS,
    INTERVAL_CHOICES_SECONDS: INTERVAL_CHOICES_SECONDS,
    REQUEST_TIMEOUT_MS: REQUEST_TIMEOUT_MS,
    BACKOFF_FACTOR: BACKOFF_FACTOR,
    BACKOFF_FACTOR_MAX: BACKOFF_FACTOR_MAX,
    BACKOFF_CAP_SECONDS: BACKOFF_CAP_SECONDS,
    MESSAGES: MESSAGES,
    isIntervalSeconds: isIntervalSeconds,
    normalizeIntervalSeconds: normalizeIntervalSeconds,
    createScheduler: createScheduler,
    presentation: presentation,
  };
})(typeof globalThis === 'undefined' ? this : globalThis);
