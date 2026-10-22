export function gauge(name, value, labels = '') {
  return `${name}${labels} ${value == null ? 'NaN' : value}\n`;
}

// Prometheus label value escaping: backslash, double quote, newline.
const escape = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
export const labels = (pairs) => `{${Object.entries(pairs).map(([k, v]) => `${k}="${escape(v)}"`).join(',')}}`;

const BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

// Request metrics per route pattern. The route label is the Fastify pattern
// (/api/v1/jurnal/:id), never the raw URL, so cardinality stays bounded by the
// number of registered routes. Unmatched URLs (404 without a route) are skipped.
export function apiMetrics(app) {
  const requests = new Map(); // method|route|status -> count
  const latency = new Map(); // method|route -> { counts, total, sum }
  const starts = new WeakMap();
  app.addHook('onRequest', async (request) => { starts.set(request, performance.now()); });
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url;
    if (!route?.startsWith('/api/v1/')) return;
    const started = starts.get(request);
    const seconds = started === undefined ? 0 : (performance.now() - started) / 1000;
    const method = request.method;
    const reqKey = `${method}|${route}|${reply.statusCode}`;
    requests.set(reqKey, (requests.get(reqKey) ?? 0) + 1);
    const latKey = `${method}|${route}`;
    let l = latency.get(latKey);
    if (!l) latency.set(latKey, l = { counts: BUCKETS.map(() => 0), total: 0, sum: 0 });
    l.total += 1;
    l.sum += seconds;
    BUCKETS.forEach((bound, i) => { if (seconds <= bound) l.counts[i] += 1; });
  });
  return () => {
    let out = '# TYPE api_requests_total counter\n';
    let errors = 0;
    for (const [key, count] of requests) {
      const [method, route, status] = key.split('|');
      out += gauge('api_requests_total', count, labels({ method, route, status }));
      if (Number(status) >= 500) errors += count;
    }
    // Kept unlabeled as a cheap total for alerts and older dashboards.
    out += '# TYPE api_errors_5xx_total counter\n' + gauge('api_errors_5xx_total', errors);
    out += '# TYPE api_request_duration_seconds histogram\n';
    for (const [key, l] of latency) {
      const [method, route] = key.split('|');
      BUCKETS.forEach((bound, i) => { out += gauge('api_request_duration_seconds_bucket', l.counts[i], labels({ method, route, le: bound })); });
      out += gauge('api_request_duration_seconds_bucket', l.total, labels({ method, route, le: '+Inf' }))
        + gauge('api_request_duration_seconds_sum', l.sum, labels({ method, route }))
        + gauge('api_request_duration_seconds_count', l.total, labels({ method, route }));
    }
    return out;
  };
}
