/** What a fresh Grafana starts with: data sources that work and one that doesn't, and a live dashboard. */

const TESTDATA = { type: 'grafana-testdata-datasource', uid: 'testdata' };

export const DATASOURCES = [
  { name: 'TestData', ...TESTDATA, access: 'proxy', isDefault: true },
  // Nothing listens there: "Save & test" fails with a connection error.
  { name: 'prometheus-prod', type: 'prometheus', uid: 'prometheus-prod', access: 'proxy', url: 'http://127.0.0.1:9' },
];

const panel = (id: number, type: string, title: string, gridPos: { x: number; y: number; w: number; h: number }) => ({
  id,
  type,
  title,
  gridPos,
  datasource: TESTDATA,
  targets: [{ refId: 'A', scenarioId: 'random_walk', seriesCount: type === 'timeseries' ? 3 : 1, datasource: TESTDATA }],
});

/** Refreshes every 5 s, so the page keeps sending requests and redrawing. */
export const DASHBOARD = {
  uid: 'service-overview',
  title: 'Service overview',
  refresh: '5s',
  time: { from: 'now-1h', to: 'now' },
  schemaVersion: 39,
  panels: [
    panel(1, 'timeseries', 'Requests per second', { x: 0, y: 0, w: 12, h: 8 }),
    panel(2, 'stat', 'Error rate', { x: 12, y: 0, w: 6, h: 8 }),
    panel(3, 'gauge', 'CPU', { x: 18, y: 0, w: 6, h: 8 }),
    panel(4, 'timeseries', 'Latency p95', { x: 0, y: 8, w: 24, h: 8 }),
  ],
};
