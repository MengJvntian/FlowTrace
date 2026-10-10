#!/usr/bin/env node
/**
 * tools/check-page.js — 「页面看不到数据」的一键诊断（只读）。
 *
 * 为什么需要它：用户报「打开页面读不了数据、刷新也有问题」，但服务端实测**接口全部 200、库里有数据**。
 * 也就是说故障只可能落在「浏览器 ↔ 页面服务」这一段，而这一段光看服务端日志看不出来。
 * 本脚本把三段分别量一遍，把问题**定位到具体哪一段**，而不是继续猜：
 *
 *   ① 服务在不在   —— 页面端口 / 网关端口是否应答
 *   ② 数据在不在   —— /api/runs、/api/meta 返回了什么（条数、库文件、候选库）
 *   ③ 页面资源对不对 —— 页面发出的 HTML/JS 与磁盘上的文件是否**同一份**（哈希比对）
 *                      这一条最关键：改过代码后如果浏览器拿到旧 JS，症状就是「打开是空的、刷新没用」。
 *
 * 用法：
 *   node tools/check-page.js                  # 默认查 http://127.0.0.1:8787
 *   node tools/check-page.js --port 8787
 *   node tools/check-page.js --json
 *
 * 退出码：0 三段都正常 / 3 有异常（脚本会明确说是哪一段）
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

/** 页面用到的静态资源（相对页面根）。 */
const ASSETS = ['/', '/app.js', '/common.js', '/filters.js', '/isr.js', '/data.js'];

/**
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<{ok: boolean, status: number | null, body: string, reason: string | null}>}
 */
async function get(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.text();
    return { ok: response.status === 200, status: response.status, body, reason: null };
  } catch (error) {
    return { ok: false, status: null, body: '', reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function sha(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法: node tools/check-page.js [--port <n>] [--manager-port <n>] [--json]');
    console.log('');
    console.log('  只读诊断「打开页面看不到数据」：分别检查服务、数据、页面资源三段。');
    console.log('  退出码：0 全正常 / 3 有异常');
    process.exit(0);
  }
  const asJson = argv.includes('--json');
  const readFlag = (name, fallback) => {
    const index = argv.indexOf(name);
    if (index === -1) return fallback;
    const value = Number(argv[index + 1]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  };
  const port = readFlag('--port', 8787);
  const managerPort = readFlag('--manager-port', 8790);
  const base = `http://127.0.0.1:${port}`;

  /** @type {Record<string, any>} */
  const report = { page_base: base, manager_base: `http://127.0.0.1:${managerPort}`, problems: [] };

  // ① 服务在不在
  const pageRoot = await get(`${base}/`);
  const managerHealth = await get(`http://127.0.0.1:${managerPort}/healthz`);
  report.services = {
    page: { ok: pageRoot.ok, status: pageRoot.status, reason: pageRoot.reason },
    manager: { ok: managerHealth.ok, status: managerHealth.status, reason: managerHealth.reason },
  };
  if (!pageRoot.ok) report.problems.push(`页面服务没应答（${base}/）：${pageRoot.reason ?? '非 200'}`);
  if (!managerHealth.ok) report.problems.push(`网关没应答（:${managerPort}/healthz）：${managerHealth.reason ?? '非 200'}——无法采集新调用；历史数据是否可读以 /api/runs 为准`);

  // ② 数据在不在
  const runs = await get(`${base}/api/runs?retention=all`);
  let runsBody = null;
  try {
    runsBody = JSON.parse(runs.body);
  } catch {
    /* 保留 null，下面如实说明 */
  }
  const runList = runsBody?.runs ?? [];
  report.data = {
    api_runs_status: runs.status,
    run_count: runList.length,
    runs: runList.map((r) => ({ run_key: r.run_key, calls: r.call_count, events: r.event_count })),
  };
  if (runs.status !== 200) report.problems.push(`/api/runs 返回 ${runs.status}（不是 200）`);
  else if (runList.length === 0) report.problems.push('/api/runs 返回 0 个运行：库是空的，或页面读的库不是你以为的那个（见 /api/meta 的候选库列表）');

  const meta = await get(`${base}/api/meta`);
  try {
    const parsed = JSON.parse(meta.body);
    report.data.db_file = parsed?.store?.file_label ?? null;
    report.data.db_exists = parsed?.store?.db_exists ?? null;
    report.data.counts = parsed?.counts ?? null;
    report.data.available_databases = (parsed?.available_databases ?? []).map((d) => d.relative);
  } catch {
    report.problems.push('/api/meta 无法解析（页面服务可能不是本项目的）');
  }

  // ③ 页面资源与磁盘是否同一份
  report.assets = [];
  for (const asset of ASSETS) {
    const served = await get(base + asset);
    if (!served.ok) {
      report.assets.push({ asset, served_status: served.status, same_as_disk: null });
      report.problems.push(`静态资源 ${asset} 取不到（HTTP ${served.status}）`);
      continue;
    }
    // `/` 是 HTML，磁盘对应 index.html；其余同名文件
    const diskRel = asset === '/' ? 'src/web/public/index.html' : `src/web/public/${asset.replace(/^\//, '')}`;
    const diskPath = path.join(REPO, diskRel);
    let same = null;
    let diskHash = null;
    let servedHash = sha(served.body);
    if (fs.existsSync(diskPath)) {
      const diskText = fs.readFileSync(diskPath, 'utf8');
      diskHash = sha(diskText);
      same = diskHash === servedHash;
    }
    report.assets.push({ asset, disk: diskRel, served_hash: servedHash, disk_hash: diskHash, same_as_disk: same });
    if (same === false) {
      report.problems.push(`静态资源 ${asset} 与磁盘不一致：浏览器拿到的是**旧文件**，症状就是「打开是空的、刷新也没用」`);
    }
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('页面数据诊断（只读）');
    console.log(`  页面：${base}    网关：${report.manager_base}\n`);
    console.log('① 服务在不在');
    console.log(`   页面服务 : ${report.services.page.ok ? '应答 ✅' : `没应答 ❌（${report.services.page.reason ?? report.services.page.status}）`}`);
    console.log(`   网关服务 : ${report.services.manager.ok ? '应答 ✅' : `没应答 ❌（${report.services.manager.reason ?? report.services.manager.status}）`}`);
    console.log('\n② 数据在不在');
    console.log(`   /api/runs -> ${report.data.api_runs_status}，${report.data.run_count} 个运行`);
    for (const r of report.data.runs ?? []) {
      console.log(`      ${String(r.run_key).padEnd(24)}calls=${String(r.calls).padStart(4)} events=${String(r.events).padStart(5)}`);
    }
    console.log(`   库文件   : ${report.data.db_file ?? '（未知）'}（存在=${report.data.db_exists ?? '?'}）`);
    if (report.data.counts) console.log(`   计数     : calls=${report.data.counts.calls} events=${report.data.counts.events}`);
    if ((report.data.available_databases ?? []).length > 0) {
      console.log(`   本机其他库: ${report.data.available_databases.join('、')}`);
    }
    console.log('\n③ 页面资源是不是最新的');
    for (const a of report.assets ?? []) {
      const mark = a.served_status !== 200 ? `资源不可访问（HTTP ${a.served_status ?? '无响应'}）` : a.same_as_disk === true ? '一致 ✅' : a.same_as_disk === false ? '不一致 ❌' : '（磁盘无对应文件，跳过）';
      console.log(`   ${String(a.asset).padEnd(12)}${mark}${a.served_hash ? `  served=${a.served_hash}` : ''}${a.disk_hash ? ` disk=${a.disk_hash}` : ''}`);
    }
    console.log('\n结论：');
    if (report.problems.length === 0) {
      console.log('  三段都正常。若浏览器里仍看不到数据，请在页面按 F12 打开控制台，把红色报错整段贴出来。');
    } else {
      for (const p of report.problems) console.log(`  ❌ ${p}`);
    }
  }

  process.exit(report.problems.length === 0 ? 0 : 3);
}

await main();
