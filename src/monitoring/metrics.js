export function gauge(name, value, labels = '') {
  return `${name}${labels} ${value == null ? 'NaN' : value}\n`;
}

export function apiMetrics(app) {
  const buckets = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
  const counts = buckets.map(() => 0);
  let total = 0, errors = 0, duration = 0;
  const starts = new WeakMap();
  app.addHook('onRequest', async (request) => { starts.set(request, performance.now()); });
  app.addHook('onResponse', async (request, reply) => {
    if (!request.routeOptions.url?.startsWith('/api/v1/')) return;
    const seconds = (performance.now() - starts.get(request)) / 1000;
    total += 1;
    errors += Number(reply.statusCode >= 500);
    duration += seconds;
    buckets.forEach((bound, i) => { if (seconds <= bound) counts[i] += 1; });
  });
  return () => '# TYPE api_requests_total counter\n' + gauge('api_requests_total', total)
    + '# TYPE api_errors_5xx_total counter\n' + gauge('api_errors_5xx_total', errors)
    + '# TYPE api_request_duration_seconds histogram\n'
    + buckets.map((bound, i) => gauge('api_request_duration_seconds_bucket', counts[i], `{le="${bound}"}`)).join('')
    + gauge('api_request_duration_seconds_bucket', total, '{le="+Inf"}')
    + gauge('api_request_duration_seconds_sum', duration) + gauge('api_request_duration_seconds_count', total);
}
