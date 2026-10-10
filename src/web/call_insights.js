// Derive display facts from retained records; never modify calls or infer intent.
import { createHash } from 'node:crypto';
import { classifyTool } from '../lineage/tools.js';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function annotateCalls(rows, events) {
  const requests = new Map(events.filter(e => e.phase === 'request').map(e => [e.gateway_call_id, e]));
  const exactSuccess = new Map(), operationSuccess = new Map();
  function remember(map, key, call) { if (!map.has(key)) map.set(key, []); map.get(key).push(call); }
  function subsequent(map, key, call) {
    const entries = map.get(key) ?? [];
    const ended = Date.parse(call.ended_at_utc), first = Date.parse(call.started_at_utc);
    if (!Number.isFinite(ended) || !Number.isFinite(first)) return null;
    for (let i = entries.length - 1; i >= 0; i--) {
      const started = Date.parse(entries[i].started_at_utc);
      if (started >= ended && started > first) return entries[i];
    }
    return null;
  }
  const ordered = rows.slice().sort((a, b) => String(b.started_at_utc ?? '').localeCompare(String(a.started_at_utc ?? '')));
  for (const call of ordered) {
    const classification = classifyTool(call, { heuristic: false });
    call.action = classification.action;
    call.action_source = classification.source;
    const operation = JSON.stringify([call.gateway_id, call.upstream_app, call.tool_name]);
    const request = requests.get(call.gateway_call_id);
    let signature = null;
    if (request && !request.truncated && request.request_json) {
      try {
        const args = JSON.parse(request.request_json)?.params?.arguments;
        if (args && typeof args === 'object' && !Array.isArray(args)) signature = operation + createHash('sha256').update(JSON.stringify(canonical(args))).digest('hex');
      } catch { /* Missing/invalid retained payload cannot prove identical parameters. */ }
    }
    call.later_success = null;
    if (call.status === 'ok') {
      if (signature) remember(exactSuccess, signature, call);
      remember(operationSuccess, operation, call);
    } else {
      const exact = signature ? subsequent(exactSuccess, signature, call) : null;
      const later = exact ?? subsequent(operationSuccess, operation, call);
      if (later) {
        call.later_success = { gateway_call_id: later.gateway_call_id, match: exact ? 'same_arguments' : 'same_operation' };
      }
    }
  }
  return rows;
}
