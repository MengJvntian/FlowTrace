// Use the official pinned server; credentials are supplied only in the environment.
if (!process.env.NOTION_TOKEN?.trim() || /[\r\n]/u.test(process.env.NOTION_TOKEN)) {
  process.stderr.write('Notion credential missing. Use applications/notion/connect.bat.\n');
  process.exit(3);
}
delete process.env.OPENAPI_MCP_HEADERS;
delete process.env.BASE_URL;
delete process.env.DEBUG;
// Vendor diagnostics can contain request details; Gateway retains business results.
console.error = () => process.stderr.write('Notion upstream diagnostic; inspect the Gateway call result for details.\n');
try { await import('../../node_modules/@notionhq/notion-mcp-server/bin/cli.mjs'); }
catch { process.stderr.write('Notion MCP startup failed. Check the installed dependency.\n'); process.exitCode = 1; }
