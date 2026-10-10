import path from 'node:path';
export function routerSpec(target, client, root, manifestFile) {
  return { command: 'powershell.exe', args: ['-NoProfile', '-File',
    path.resolve(root, 'tools/run-application-router.ps1'), '-App', target.id, '-Agent', client, '-Manifest', path.resolve(manifestFile)] };
}
export function generateRouterRoutes(targets, client, root, manifestFile) {
  if (!['codex', 'dsh'].includes(client)) throw new Error('Unsupported client');
  const entries = targets.map(target => {
    if (!target.id) {
      if (client !== 'dsh') throw new Error('Only legacy DSH demo entries can omit an application ID');
      return `    - id: mcp-trace-${target.serverName}\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: ${target.serverName}\n        transport: streamable-http\n        url: ${JSON.stringify(target.dsh)}\n        failOnStartupError: false\n        toolCallTimeoutMs: 120000`;
    }
    const spec = routerSpec(target, client, root, manifestFile);
    return client === 'codex'
      ? `[mcp_servers.trace_${target.serverName}]\ncommand = ${JSON.stringify(spec.command)}\nargs = ${JSON.stringify(spec.args)}\nenabled = true\nrequired = false\nstartup_timeout_sec = 15\ntool_timeout_sec = 120`
      : `    - id: mcp-trace-${target.serverName}\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: ${target.serverName}\n        transport: stdio\n        command: ${JSON.stringify(spec.command)}\n        args:\n${spec.args.map(value => '          - ' + JSON.stringify(value)).join('\n')}\n        failOnStartupError: false\n        toolCallTimeoutMs: 120000`;
  });
  return '# BEGIN managed application Gateway routes\n' + (client === 'dsh' && entries.length ? '- insert:\n' : '') + entries.join('\n\n') + '\n# END managed application Gateway routes\n';
}
