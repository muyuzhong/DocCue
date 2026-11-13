/**
 * Single-step scenarios: a page, a question, and where the first guide step should point.
 * They measure grounding: does the model pick the right element from the screen snapshot?
 */
export interface Scenario {
  name: string;
  locale: string;
  /** What the host app would put in `instructions`. */
  app: string;
  path: string;
  title: string;
  html: string;
  question: string;
  /** CSS selector of the element(s) the first step may point at; `null` when no guide is wanted. */
  expect: string | null;
}

const DATA_PLATFORM = '你是「数据平台」的应用内助手。数据平台用来接入和管理数据库数据源。主机地址只填 IP 或域名，不带协议和端口。默认端口：MySQL 3306，PostgreSQL 5432。';
const NAV_ZH = `<nav aria-label="主菜单"><a href="/datasource" id="nav-list">数据源</a><a href="/datasource/new" id="nav-new">新建数据源</a><a href="/dashboard">仪表盘</a></nav>`;
const TEAM_APP = 'You are the in-app assistant of Trackly, a project tracker for small teams.';

export const scenarios: Scenario[] = [
  {
    name: 'zh: field with a validation error',
    locale: 'zh-CN',
    app: DATA_PLATFORM,
    path: '/datasource/new',
    title: '新建数据源',
    html: `${NAV_ZH}<h1>新建数据源</h1>
      <form aria-label="连接信息">
        <label for="name">名称</label><input id="name" />
        <label for="host">主机地址</label><input id="host" value="http://10.0.0.5:3306" aria-invalid="true" />
        <p role="alert">Invalid Host Format</p>
        <label for="port">端口</label><input id="port" value="3306" />
        <button type="button" id="test">测试连接</button><button type="submit" disabled>保存</button>
      </form>`,
    question: '为什么连不上？',
    expect: '#host',
  },
  {
    name: 'zh: how to get somewhere',
    locale: 'zh-CN',
    app: DATA_PLATFORM,
    path: '/dashboard',
    title: '仪表盘',
    html: `${NAV_ZH}<h1>仪表盘</h1><section><h2>数据源</h2><p>3</p></section><section><h2>今日查询</h2><p>1,284</p></section>`,
    question: '怎么新建一个数据源？',
    expect: '#nav-new, #nav-list',
  },
  {
    name: 'zh: a question that needs no pointing',
    locale: 'zh-CN',
    app: DATA_PLATFORM,
    path: '/dashboard',
    title: '仪表盘',
    html: `${NAV_ZH}<h1>仪表盘</h1><section><h2>数据源</h2><p>3</p></section>`,
    question: 'MySQL 的默认端口是多少？',
    expect: null,
  },
  {
    name: 'en: the right row of a table',
    locale: 'en-US',
    app: TEAM_APP,
    path: '/projects',
    title: 'Projects',
    html: `<nav aria-label="Main"><a href="/projects">Projects</a><a href="/members">Members</a><a href="/settings">Settings</a></nav>
      <h1>Projects</h1><button id="create">New project</button>
      <table aria-label="Projects"><tbody>
        <tr><td>Website redesign</td><td>12 open</td><td><button>Archive</button><button>Delete</button></td></tr>
        <tr><td>Staging cleanup</td><td>3 open</td><td><button>Archive</button><button id="delete-staging">Delete</button></td></tr>
        <tr><td>Mobile app</td><td>27 open</td><td><button>Archive</button><button>Delete</button></td></tr>
      </tbody></table>`,
    question: 'How do I delete the Staging cleanup project?',
    expect: '#delete-staging',
  },
  {
    name: 'en: an icon button named only by aria-label',
    locale: 'en-US',
    app: TEAM_APP,
    path: '/members',
    title: 'Members',
    html: `<nav aria-label="Main"><a href="/projects">Projects</a><a href="/members" aria-current="page">Members</a><a href="/settings">Settings</a></nav>
      <h1>Members</h1>
      <div role="toolbar"><input type="search" placeholder="Search members" /><button aria-label="Export list"><svg></svg></button><button aria-label="Invite member" id="invite"><svg></svg></button></div>
      <table aria-label="Members"><tbody><tr><td>Ana</td><td>Admin</td></tr><tr><td>Bo</td><td>Member</td></tr></tbody></table>`,
    question: 'How can I add a colleague to the team?',
    expect: '#invite',
  },
  {
    name: 'en: a tab on the current page',
    locale: 'en-US',
    app: TEAM_APP,
    path: '/settings',
    title: 'Settings',
    html: `<nav aria-label="Main"><a href="/projects">Projects</a><a href="/members">Members</a><a href="/settings" aria-current="page">Settings</a></nav>
      <h1>Settings</h1>
      <div role="tablist"><button role="tab" aria-selected="true">Profile</button><button role="tab" id="security">Security</button><button role="tab">Notifications</button></div>
      <form aria-label="Profile"><label for="display">Display name</label><input id="display" value="Ana" /><button type="submit">Save</button></form>`,
    question: 'Where do I change my password?',
    expect: '#security',
  },
  {
    name: 'en: a field inside an open dialog',
    locale: 'en-US',
    app: TEAM_APP,
    path: '/projects',
    title: 'Projects',
    html: `<h1>Projects</h1><button>New project</button>
      <div role="dialog" aria-labelledby="dlg"><h2 id="dlg">New project</h2>
        <label for="pname">Name</label><input id="pname" value="Q3 roadmap" />
        <label for="key">Key</label><input id="key" value="q3 roadmap!" aria-invalid="true" />
        <p role="alert">Key may only contain letters and numbers</p>
        <button>Cancel</button><button id="create">Create</button>
      </div>`,
    question: "It won't let me create the project. What's wrong?",
    expect: '#key',
  },
];
