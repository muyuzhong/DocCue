/** Grafana's screens to look at and questions to ask (`look`, `ask`). */
import type { Case, Host, HostApp, View } from '../host.js';
import { startGrafana } from './grafana.js';

const views: View[] = [
  { name: 'home', path: '/' },
  { name: 'datasources', path: '/connections/datasources' },
  { name: 'add-datasource', path: '/connections/datasources/new' },
  { name: 'datasource-config', path: '/connections/datasources/edit/prometheus-prod' },
  { name: 'dashboard', path: '/d/service-overview' },
  { name: 'time-picker', path: '/d/service-overview', prepare: (page) => page.getByTestId('data-testid TimePicker Open Button').click() },
  { name: 'panel-editor', path: '/d/service-overview?editPanel=1' },
  { name: 'new-alert-rule', path: '/alerting/new/alerting' },
];

const dashboard = async (grafana: Host) =>
  ((await grafana.api('/api/dashboards/uid/service-overview')) as { dashboard: { panels: Array<{ id: number; title: string }> } }).dashboard;

const cases: Case[] = [
  {
    name: 'fix-prometheus',
    start: '/connections/datasources/edit/prometheus-prod',
    prepare: async (page) => {
      await page.getByRole('button', { name: '保存并测试' }).click();
      await page.waitForTimeout(3000);
    },
    question: '为什么测试失败了？该怎么改？',
    first: /URL/i,
    firstOnly: true,
  },
  {
    name: 'new-mysql',
    start: '/',
    question: '我想新建一个 MySQL 数据源，名字叫 orders，地址是 10.0.0.8:3306，数据库 shop，用户名 app，密码 secret，带我做一遍。',
    values: [
      [/filter|筛选|搜索|search/i, 'MySQL'],
      [/^name$|名称/i, 'orders'],
      [/host|主机|url/i, '10.0.0.8:3306'],
      [/database|数据库/i, 'shop'],
      [/user|用户/i, 'app'],
      [/password|密码/i, 'secret'],
    ],
    first: /连接|数据源|添加新连接|新建|connection/i,
    goal: async (grafana) => ((await grafana.api('/api/datasources')) as Array<{ type: string; name: string; url: string }>).some((d) => d.type === 'mysql' && d.name === 'orders' && d.url === '10.0.0.8:3306'),
  },
  {
    name: 'fix-mysql-form',
    start: '/connections/datasources/edit/mysql-orders',
    question: '帮我把这个 MySQL 数据源改成连 10.0.0.8:3306，数据库 shop，用户名 app，密码 secret，然后保存。带我做一遍。',
    values: [
      [/host/i, '10.0.0.8:3306'],
      [/database|数据库/i, 'shop'],
      [/user|用户/i, 'app'],
      [/password|密码/i, 'secret'],
    ],
    first: /host/i,
    goal: async (grafana) => {
      const saved = (await grafana.api('/api/datasources/uid/mysql-orders')) as { url: string; user: string; jsonData: { database?: string }; secureJsonFields: { password?: boolean } };
      return saved.url === '10.0.0.8:3306' && saved.user === 'app' && saved.jsonData.database === 'shop' && saved.secureJsonFields.password === true;
    },
  },
  {
    name: 'refresh-off',
    start: '/d/service-overview',
    question: '这个仪表盘一直在自动刷新，怎么关掉？',
    first: /刷新/,
    goal: async (_grafana, page) => !page.url().includes('refresh='),
  },
  {
    name: 'time-7d',
    start: '/d/service-overview',
    question: '把时间范围改成最近 7 天。',
    first: /时间范围/,
    goal: async (_grafana, page) => page.url().includes('from=now-7d'),
  },
  {
    name: 'rename-panel',
    start: '/d/service-overview',
    question: '把 CPU 这个面板的标题改成 CPU usage，再保存仪表盘，带我做一遍。',
    values: [[/标题|title/i, 'CPU usage']],
    // The panel's menu only shows while the pointer is over the panel: a hint the script can't follow.
    orSaid: /悬停|移到|hover/i,
    goal: async (grafana) => (await dashboard(grafana)).panels.some((panel) => panel.id === 3 && panel.title === 'CPU usage'),
  },
  {
    name: 'scenario-csv',
    start: '/d/service-overview?editPanel=1',
    question: '把这个查询的场景从 Random Walk 换成 CSV Metric Values。',
    values: [[/scenario/i, 'CSV Metric Values']],
    first: /scenario/i,
    goal: async (_grafana, page) => page.getByText('CSV Metric Values', { exact: true }).first().isVisible(),
  },
  {
    name: 'alert-rule-first-step',
    start: '/',
    question: '怎么新建一条告警规则？',
    first: /警报|告警|alert|新建/i,
    firstOnly: true,
  },
  {
    name: 'english-add-datasource',
    start: '/',
    question: 'How do I add a new data source?',
    answerIn: 'en',
    first: /连接|数据源|添加新连接|新建|connection|data source/i,
    firstOnly: true,
  },
  {
    // Chinese with product words in English: the message's language is still Chinese.
    name: 'mixed-zh',
    start: '/connections/datasources/edit/prometheus-prod',
    prepare: async (page) => {
      await page.getByRole('button', { name: '保存并测试' }).click();
      await page.waitForTimeout(3000);
    },
    question: 'prometheus-prod 这个 datasource 为什么 test 失败了？',
    first: /URL/i,
    firstOnly: true,
    answerIn: 'zh',
  },
  {
    name: 'no-guide',
    start: '/connections/datasources',
    question: 'TestData 这个数据源是用来做什么的？',
    first: null,
  },
];

export const app: HostApp = {
  name: 'grafana',
  start: startGrafana,
  views,
  cases,
  loading: /正在加载|Loading\.\.\./,
};
