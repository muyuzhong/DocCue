/**
 * Homebox's screens to look at and questions to ask (`look`, `ask`). The UI is in Chinese
 * unless a case says otherwise; the seeded data mixes Chinese item names with the English
 * locations and tags every new collection gets.
 */
import type { Case, Host, HostApp, View } from '../host.js';
import { startHomebox } from './homebox.js';

interface Entity {
  id: string;
  name: string;
  quantity: number;
  parent?: { id: string; name: string };
  tags: Array<{ name: string }>;
  warrantyExpires?: string;
}

const entities = async (host: Host) => ((await host.api('/api/v1/entities')) as { items: Entity[] }).items;
const entity = async (host: Host, name: string) => {
  const found = (await entities(host)).find((item) => item.name === name);
  return found ? ((await host.api(`/api/v1/entities/${found.id}`)) as Entity) : undefined;
};
/** The page of a seeded item, e.g. `/item/<id>`, or one of its sub-pages. */
const itemPage = (name: string, sub = '') => async (host: Host) => {
  const found = (await entities(host)).find((item) => item.name === name);
  if (!found) throw new Error(`no item "${name}"`);
  return `/item/${found.id}${sub}`;
};
interface TreeNode {
  name: string;
  children: TreeNode[];
}
const tree = async (host: Host) => (await host.api('/api/v1/entities/tree')) as TreeNode[];

/** A date in the month a date picker opens on, so the script can click it: the 28th of this month. */
const DUE = new Date(new Date().getFullYear(), new Date().getMonth(), 28).toLocaleDateString('sv-SE');

const views: View[] = [
  { name: 'home', path: '/home' },
  { name: 'create-menu', path: '/home', prepare: (page) => page.getByRole('button', { name: '创建' }).first().click() },
  {
    name: 'create-item',
    path: '/home',
    prepare: async (page) => {
      await page.getByRole('button', { name: '创建' }).first().click();
      await page.waitForTimeout(500);
      await page.getByRole('menuitem', { name: /物品/ }).first().click();
    },
  },
  { name: 'locations', path: '/locations' },
  { name: 'items', path: '/items' },
  { name: 'item', path: itemPage('电钻') },
  { name: 'item-edit', path: itemPage('电钻', '/edit') },
  { name: 'item-maintenance', path: itemPage('咖啡机', '/maintenance') },
  { name: 'entity-types', path: '/collection/entity-types' },
  { name: 'tags', path: '/tags' },
];

const cases: Case[] = [
  {
    name: 'new-item',
    start: '/home',
    question: '帮我登记一个新物品：螺丝刀套装，放在 Garage，数量 3。带我做一遍。',
    values: [
      [/名称|name/i, '螺丝刀套装'],
      [/数量|quantity/i, '3'],
      [/位置|location|父/i, 'Garage'],
    ],
    first: /创建|create/i,
    goal: async (host) => {
      const item = await entity(host, '螺丝刀套装');
      return item?.quantity === 3 && item.parent?.name === 'Garage';
    },
  },
  {
    name: 'new-location',
    start: '/locations',
    question: '在 Garage 下面新建一个位置，叫 Shelf A。带我做一遍。',
    values: [
      [/名称|name/i, 'Shelf A'],
      [/父|位置|parent|location/i, 'Garage'],
    ],
    goal: async (host) => (await tree(host)).find((node) => node.name === 'Garage')?.children.some((child) => child.name === 'Shelf A') ?? false,
  },
  {
    name: 'warranty',
    start: itemPage('电钻'),
    question: `把这个电钻的保修到期日设成 ${DUE}，然后保存。`,
    values: [[/保修|warranty/i, DUE]],
    first: /编辑|修改|edit/i,
    goal: async (host) => (await entity(host, '电钻'))?.warrantyExpires?.startsWith(DUE) ?? false,
  },
  {
    name: 'maintenance',
    start: itemPage('咖啡机'),
    question: `给这台咖啡机加一条维护计划：除垢，计划日期 ${DUE}。`,
    values: [
      [/名称|name/i, '除垢'],
      [/预定|计划|scheduled/i, DUE],
    ],
    goal: async (host) => {
      const id = (await itemPage('咖啡机')(host)).split('/').pop()!;
      const entries = (await host.api(`/api/v1/entities/${id}/maintenance`)) as Array<{ name: string; scheduledDate?: string }>;
      return entries.some((entry) => entry.name === '除垢' && (entry.scheduledDate ?? '').startsWith(DUE));
    },
  },
  {
    name: 'tag-router',
    start: itemPage('路由器'),
    question: '给路由器加上 Important 标签。',
    values: [[/标签|tag/i, 'Important']],
    goal: async (host) => (await entity(host, '路由器'))?.tags.some((tag) => tag.name === 'Important') ?? false,
  },
  {
    name: 'move-drill',
    start: itemPage('电钻'),
    question: '把电钻挪到 Basement。',
    values: [[/位置|location|parent|父/i, 'Basement']],
    goal: async (host) => (await entity(host, '电钻'))?.parent?.name === 'Basement',
  },
  {
    name: 'entity-type',
    start: '/home',
    question: '我想新建一种叫“抽屉”的位置类型，带我做一遍。',
    values: [[/名称|name/i, '抽屉']],
    goal: async (host) => ((await host.api('/api/v1/entity-types')) as Array<{ name: string; isLocation: boolean }>).some((type) => type.name === '抽屉' && type.isLocation),
  },
  {
    name: 'english-new-location',
    start: '/home',
    question: 'How do I add a new location?',
    answerIn: 'en',
    first: /创建|create/i,
    firstOnly: true,
  },
  {
    // A Chinese question on the English UI.
    name: 'zh-on-english-ui',
    language: 'en-US',
    start: '/home',
    question: '怎么新建一个位置？',
    answerIn: 'zh',
    first: /create/i,
    firstOnly: true,
  },
  // What only the docs say. Run with DOCS=off to see the difference they make.
  {
    name: 'docs-asset-search',
    start: '/home',
    question: '怎么按资产编号找物品？比如编号 000-001。',
    // No value for the search box: the script would type the answer for the model.
    says: /#\s?000-001/,
  },
  {
    name: 'docs-csv-nested',
    start: '/collection/tools',
    question: '用 CSV 导入物品时，怎么把物品放进嵌套的位置，比如 Home 下面 Office 里的 Desk？',
    says: /Home\s*\/\s*Office\s*\/\s*Desk/,
  },
  {
    name: 'docs-csv-dedupe',
    start: '/collection/tools',
    question: '我打算以后一直用 CSV 维护物品，怎么避免再次导入时出现重复？',
    says: /import_ref/,
  },
  {
    name: 'docs-notify-time',
    start: '/maintenance',
    question: '维护计划的提醒会在几点发出？',
    says: /(8|八)\s*(点|时|:00|am)/i,
  },
  {
    name: 'docs-delete-location',
    start: '/locations',
    question: '如果删除一个位置，里面放的物品会怎么样？',
    says: /(一并|一起|同时|随之|都会|也会).{0,6}被?删|(连同|连带).{0,10}物品/,
    never: /物品.{0,4}不会被?删|不会被删除|不会连.{0,10}删|失去.{0,4}(归属|位置)|游离|没有位置归属/,
  },
  {
    name: 'docs-asset-skip',
    start: itemPage('备用硬盘'),
    question: '备用硬盘这种耗材我不想让它占用资产编号，该怎么设置？',
    says: /(清空|留空|删掉|删除|空着).{0,10}(资产|编号|ID)|(资产|编号|ID).{0,10}(清空|留空|删掉|空着|为空)/i,
  },
  {
    name: 'docs-custom-field-types',
    start: itemPage('电钻', '/edit'),
    question: '自定义字段能设成数字或者日期类型吗？',
    says: /(只|仅).{0,8}(文本|text)/i,
  },
  {
    name: 'docs-copy-https',
    start: itemPage('电钻'),
    question: '物品详情里那个复制按钮点了没反应，是怎么回事？',
    says: /https|localhost/i,
  },
];

export const app: HostApp = { name: 'homebox', start: startHomebox, views, cases };
