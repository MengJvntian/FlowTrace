/* Read a complete view before committing it. New selections invalidate old reads. */
(function (root) {
  'use strict';
  function createReader(fetchJson) {
    var revision = 0;
    var active = null;
    var savedVersion = null, savedRun = null;
    function cancel() {
      revision++;
      if (active) active.abort();
      active = null;
    }
    async function read(options) {
      cancel();
      var version = revision;
      var controller = new AbortController();
      active = controller;
      var signal = options.signal;
      function abort() { controller.abort(); }
      if (signal) {
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }
      var request = { signal: controller.signal };
      try {
        var stamp = options.checkRevision ? await fetchJson('/api/revision', request) : null;
        if (stamp && typeof stamp.version !== 'string') throw new Error('数据版本格式无效');
        if (stamp && !options.force && stamp.version === savedVersion && (options.selectedRun || options.fromUrl || '') === savedRun) {
          if (version !== revision) return null;
          if (controller.signal.aborted) throw new Error('读取已取消');
          return { unchanged: true };
        }
        var runs = await fetchJson('/api/runs?retention=all', request);
        if (!runs || !Array.isArray(runs.runs)) throw new Error('任务列表格式无效');
        var keys = runs.runs.map(options.runKey);
        var requested = options.selectedRun || options.fromUrl;
        var key = keys.indexOf(requested) !== -1 ? requested : (keys[0] || '');
        var pair = key ? await Promise.all([
          fetchJson('/api/runs/' + encodeURIComponent(key) + '/timeline?compact=1', request),
          fetchJson('/api/runs/' + encodeURIComponent(key) + '/flows?compact=1', request),
        ]) : [null, null];
        if (version !== revision) return null;
        if (controller.signal.aborted) throw new Error('读取已取消');
        savedVersion = stamp && stamp.version;
        savedRun = key;
        return { runs: runs, selectedRun: key, timeline: pair[0], flows: pair[1] };
      } catch (error) {
        if (version !== revision) return null;
        controller.abort();
        throw error;
      } finally {
        if (signal) signal.removeEventListener('abort', abort);
        if (version === revision) active = null;
      }
    }
    return { read: read, cancel: cancel };
  }
  root.TraceData = { createReader: createReader };
})(window);
