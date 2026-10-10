/**
 * src/demo/stack.js — 两条运行路径的「客户端 → Gateway → 上游 Mock Server」装配（G1）
 *
 * 路径 A（`inproc`，沙箱内可自动化）：
 *   真实 `src/gateway/gateway.js`（SDK Server + SDK Client）+ 真实 `src/mock_servers/*`，
 *   两者之间用**真实 SDK stdio 传输 + PassThrough 内存流**连线，仅把「OS 进程边界」
 *   换成「内存流边界」；JSON 分帧、协商、错误语义全部是真实实现。
 *   两个 Gateway 实例各自打开同一个 SQLite 文件（等价于两个进程共用一个库）。
 *   参考 tests/helpers/gateway_harness.js 的拓扑（bin/src 不能 import tests/，故此处自带两个小工具）。
 *
 * 路径 B（`subprocess`，真实跨进程 stdio）：
 *   真实 spawn `bin/gateway.js` 子进程（每个 Gateway 再 spawn 自己的上游 Mock Server），
 *   用 `@modelcontextprotocol/client/stdio` 的 `StdioClientTransport` 连接。
 *   本沙箱禁止带管道的子进程 stdio（CONVENTIONS §1.1.2），因此路径 B 在此**必然**在 spawn 阶段失败；
 *   失败由 bin/demo.js 转成可辨识诊断 + 退出码 3（绝不静默降级为路径 A）。
 *
 * 两条路径对外暴露**同一形状**的观测：
 *   { kind, config, client, frames: { toClient(), fromClient(), toUpstream?, fromUpstream? }, close() }
 * 因此证据生成器（src/demo/evidence.js）对两种模式走同一段代码。
 */
import { PassThrough, Transform } from 'node:stream';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { openStore } from '../collector/store.js';
import { createGateway } from '../gateway/gateway.js';
import { RecordingTransport } from '../gateway/transport.js';

export const DEMO_CLIENT_VERSION = '0.1.0';

/**
 * 插入式字节 tap：不改变内容，只复制一份字符串（与 tests/helpers/gateway_harness.js 同源实现）。
 * @param {string} label
 */
export function createByteTap(label) {
  /** @type {string[]} */
  const chunks = [];
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback(null, chunk);
    },
  });
  stream.label = label;
  return { stream, chunks };
}

/**
 * 按行拆分的非空帧（stdio 传输是 newline-delimited JSON）。
 * @param {readonly string[]} chunks
 * @returns {string[]}
 */
export function framesOf(chunks) {
  return chunks
    .join('')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * 路径 A：进程内同构栈。
 *
 * @param {{
 *   config: Record<string, any>,
 *   store?: any,
 *   buildUpstreamServer: () => any,
 *   clientName: string,
 *   logger?: (message: string) => void,
 * }} options
 * @returns {Promise<Record<string, any>>}
 */
export async function createInProcessGatewayStack(options) {
  const { config } = options;
  const logger = typeof options.logger === 'function' ? options.logger : (message) => process.stderr.write(`${message}\n`);
  const store =
    options.store ?? openStore(config.dbPath, { maxPayloadBytes: config.maxPayloadBytes });
  const ownsStore = options.store === undefined;

  // ── 客户端 ↔ Gateway：真实 stdio 传输 + 内存流 ─────────────────────────────
  const clientToGateway = new PassThrough();
  const gatewayStdinTap = createByteTap('gateway-stdin');
  clientToGateway.pipe(gatewayStdinTap.stream);
  const gatewayToClientRaw = new PassThrough();
  const gatewayStdoutTap = createByteTap('gateway-stdout');
  gatewayToClientRaw.pipe(gatewayStdoutTap.stream);

  const gatewayServerTransport = new StdioServerTransport(gatewayStdinTap.stream, gatewayToClientRaw);
  const clientInnerTransport = new StdioServerTransport(gatewayStdoutTap.stream, clientToGateway);

  // ── Gateway ↔ 上游 Mock Server：真实 stdio 传输 + 内存流 ───────────────────
  const gatewayToUpstream = new PassThrough();
  const upstreamStdinTap = createByteTap('upstream-stdin');
  gatewayToUpstream.pipe(upstreamStdinTap.stream);
  const upstreamToGateway = new PassThrough();
  const upstreamStdoutTap = createByteTap('upstream-stdout');
  upstreamToGateway.pipe(upstreamStdoutTap.stream);

  const upstreamServer = options.buildUpstreamServer();
  const upstreamServerTransport = new StdioServerTransport(upstreamStdinTap.stream, upstreamToGateway);
  const upstreamClientTransportInner = new StdioServerTransport(upstreamStdoutTap.stream, gatewayToUpstream);
  // 进程内没有 OS 子进程：显式把退出信息标为「无 pid」，不留猜测空间。
  upstreamClientTransportInner.exitInfo = () => ({ pid: null, exit_code: null, signal_code: null, source: 'in-process' });
  const upstreamTransport = new RecordingTransport(upstreamClientTransportInner, { label: 'upstream' });

  await upstreamServer.connect(upstreamServerTransport);

  const gateway = await createGateway({
    config,
    store,
    logger,
    serverTransport: gatewayServerTransport,
    upstreamTransportFactory: () => upstreamTransport,
  });
  await gateway.start();

  if (gateway.state.upstream_ready !== true) {
    throw new Error(
      `路径 A 装配失败：Gateway ${config.gatewayId} 未能连上进程内上游（${gateway.state.unavailable_reason ?? '未知原因'}）`,
    );
  }

  const client = new Client(
    { name: options.clientName, version: DEMO_CLIENT_VERSION },
    { capabilities: {} },
  );
  await client.connect(clientInnerTransport);

  let closed = false;
  return {
    kind: 'inproc',
    config,
    store,
    ownsStore,
    client,
    gateway,
    upstreamServer,
    upstreamTransport,
    process_boundary: 'in-process (real SDK stdio transports over in-memory streams)',
    upstream_pid: null,
    frames: {
      toClient: () => framesOf(gatewayStdoutTap.chunks),
      fromClient: () => framesOf(gatewayStdinTap.chunks),
      toUpstream: () => framesOf(upstreamStdinTap.chunks),
      fromUpstream: () => framesOf(upstreamStdoutTap.chunks),
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await client.close();
      } catch {
        /* 忽略 */
      }
      try {
        await gateway.stop({ reason: 'demo-teardown' });
      } catch {
        /* 忽略 */
      }
      try {
        await upstreamServer.close();
      } catch {
        /* 忽略 */
      }
      if (ownsStore) {
        try {
          store.close();
        } catch {
          /* 忽略 */
        }
      }
    },
  };
}

/**
 * 路径 A（直连）：用 SDK 的真实 `InMemoryTransport` 把 Client 连到真实 Mock Server 实例。
 * 用于「直连基线」——透明性对照必须拿直连结果与经 Gateway 的结果比，而不是自比。
 * @param {{buildServer: () => any, clientName: string}} options
 * @returns {Promise<Record<string, any>>}
 */
export async function connectInProcessServer(options) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = options.buildServer();
  const client = new Client(
    { name: options.clientName, version: DEMO_CLIENT_VERSION },
    { capabilities: {} },
  );
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  let closed = false;
  return {
    kind: 'inproc-server',
    client,
    server,
    transport: clientTransport,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await client.close();
      } catch {
        /* 忽略 */
      }
      try {
        await server.close();
      } catch {
        /* 忽略 */
      }
    },
  };
}

/**
 * 路径 B（直连）：真实 spawn Mock Server 并用 StdioClientTransport 连接。
 * 失败原样抛出（由调用方判定是否为沙箱管道限制）。
 * @param {{nodeBin: string, entry: string, args?: string[], repoRoot: string, clientName: string, stderr?: any}} options
 * @returns {Promise<Record<string, any>>}
 */
export async function connectSubprocessServer(options) {
  const inner = new StdioClientTransport({
    command: options.nodeBin,
    args: [options.entry, ...(options.args ?? [])],
    cwd: options.repoRoot,
    stderr: options.stderr ?? 'inherit',
  });
  const transport = new RecordingTransport(inner, { label: options.entry });
  const client = new Client(
    { name: options.clientName, version: DEMO_CLIENT_VERSION },
    { capabilities: {} },
  );
  await client.connect(transport);
  return {
    kind: 'subprocess-server',
    client,
    transport,
    inner,
    pid: inner.pid ?? null,
    frames: {
      fromClient: () => transport.outboundTexts().flatMap((text) => framesOf([text])),
      toClient: () => transport.inboundTexts().flatMap((text) => framesOf([text])),
    },
    async close() {
      try {
        await client.close();
      } catch {
        /* 忽略 */
      }
      try {
        await transport.close();
      } catch {
        /* 忽略 */
      }
    },
  };
}

/**
 * 路径 B：构造 `bin/gateway.js` 子进程的参数（照抄 CONVENTIONS / 队长给出的启动命令形态）。
 * @param {{upstreamApp: string, gatewayId: string, clientLabel: string, experimentRunId: string,
 *   dbPath: string, timeoutMs?: number, upstreamEntry: string, upstreamArgs?: string[], transport?: string}} config
 * @param {string} nodeBin
 * @returns {string[]}
 */
export function gatewaySubprocessArgs(config, nodeBin) {
  const args = [
    'bin/gateway.js',
    '--upstream-command',
    nodeBin,
    '--upstream-arg',
    config.upstreamEntry,
    ...(config.upstreamArgs ?? []).flatMap((value) => ['--upstream-arg', value]),
    '--upstream-app',
    config.upstreamApp,
    '--gateway-id',
    config.gatewayId,
    '--client-label',
    config.clientLabel,
    '--experiment-run-id',
    config.experimentRunId,
    '--db',
    config.dbPath,
    '--transport',
    config.transport ?? 'stdio',
    '--timeout-ms',
    String(config.timeoutMs ?? 60000),
  ];
  return args;
}

/** 连接超时（真实管道环境下上游启动较慢时的上限；沙箱内 spawn 立即失败，不会走到这里）。 */
const CONNECT_TIMEOUT_MS = 60000;

/**
 * 路径 B：真实 spawn `bin/gateway.js` 并用 StdioClientTransport 连接。
 *
 * 失败**原样抛出**（不吞、不改写、不降级），由调用方（bin/demo.js）转成可辨识诊断。
 * @param {{
 *   config: Record<string, any>,
 *   nodeBin: string,
 *   repoRoot: string,
 *   clientName: string,
 *   stderr?: any,
 *   logger?: (message: string) => void,
 * }} options
 * @returns {Promise<Record<string, any>>}
 */
export async function createSubprocessGatewayStack(options) {
  const { config, nodeBin, repoRoot } = options;
  const logger = typeof options.logger === 'function' ? options.logger : (message) => process.stderr.write(`${message}\n`);
  const args = gatewaySubprocessArgs(config, nodeBin);

  const inner = new StdioClientTransport({
    command: nodeBin,
    args,
    cwd: repoRoot,
    stderr: options.stderr ?? 'inherit',
  });
  const transport = new RecordingTransport(inner, { label: `gateway:${config.gatewayId}` });
  const client = new Client(
    { name: options.clientName, version: DEMO_CLIENT_VERSION },
    { capabilities: {} },
  );

  /** @type {any} */
  let timer;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`连接 Gateway ${config.gatewayId} 超时（${CONNECT_TIMEOUT_MS}ms）`);
          // @ts-expect-error 运行时附码，便于调用方区分
          error.code = 'DEMO_CONNECT_TIMEOUT';
          reject(error);
        }, CONNECT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }

  logger(
    `[demo] 路径 B：Gateway ${config.gatewayId} 子进程已连接 pid=${inner.pid ?? 'n/a'} ` +
      `upstream_app=${config.upstreamApp}（命令：${nodeBin} ${args.join(' ')}）`,
  );

  let closed = false;
  return {
    kind: 'subprocess',
    config,
    client,
    transport,
    inner,
    process_boundary: 'real child process + stdio pipes',
    upstream_pid: null,
    gateway_pid: inner.pid ?? null,
    gateway_command: `${nodeBin} ${args.join(' ')}`,
    frames: {
      // client→gateway 的每一帧（即 Gateway 的 stdin）
      fromClient: () => transport.outboundTexts().flatMap((text) => framesOf([text])),
      // gateway→client 的每一帧（即 Gateway 的 stdout；能解析成功本身就说明 stdout 只有协议帧）
      toClient: () => transport.inboundTexts().flatMap((text) => framesOf([text])),
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await client.close();
      } catch {
        /* 忽略 */
      }
      try {
        await transport.close();
      } catch {
        /* 忽略 */
      }
    },
  };
}
