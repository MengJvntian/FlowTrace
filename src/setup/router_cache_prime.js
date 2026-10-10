import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { routerContext, writeToolCache } from './router_context.js';
// Complete discovery for every selected app before touching any client config.
export async function primeRouterCaches(root, manifestFile, targets) {
  const discovered = [];
  for (const target of targets) {
    const client = new Client({ name: 'flowtrace-router-definition-check', version: '1.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(target.codex)), { timeout: 10000 });
      const tools = [], seen = new Set();
      let cursor;
      do {
        const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: 15000, cacheMode: 'refresh' });
        tools.push(...result.tools);
        cursor = result.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error('Repeated discovery cursor');
        if (cursor) seen.add(cursor);
      } while (cursor);
      if (!tools.length || tools.some(tool => tool.name === 'trace_monitoring_status')) throw new Error('Invalid discovery');
      discovered.push({ ctx: routerContext(root, manifestFile, target.id, 'codex'), tools });
    } finally { await client.close(); }
  }
  for (const { ctx, tools } of discovered) writeToolCache(ctx, tools);
}
