/** What a fresh Homebox starts with, besides the locations and tags every new collection gets. */
import type { Host } from '../host.js';

interface Named {
  id: string;
  name: string;
}

export const ITEMS = [
  { name: '电钻', location: 'Garage', tags: ['Appliances'], quantity: 1, manufacturer: 'Bosch', modelNumber: 'GSR 120-LI' },
  { name: '咖啡机', location: 'Kitchen', tags: ['Appliances'], quantity: 1, manufacturer: "De'Longhi" },
  { name: '路由器', location: 'Office', tags: ['Electronics', 'IOT'], quantity: 1 },
  { name: '备用硬盘', location: 'Office', tags: ['Servers'], quantity: 2 },
  { name: '露营帐篷', location: 'Basement', tags: ['General'], quantity: 1 },
];

const idOf = (list: Named[], name: string) => {
  const found = list.find((entry) => entry.name === name);
  if (!found) throw new Error(`Homebox seed: no "${name}"`);
  return found.id;
};

export async function seed(api: Host['api']): Promise<void> {
  const types = (await api('/api/v1/entity-types')) as Array<Named & { isLocation: boolean }>;
  const itemType = types.find((type) => !type.isLocation)!;
  const locations = (await api('/api/v1/entities/tree')) as Named[];
  const tags = (await api('/api/v1/tags')) as Named[];
  for (const item of ITEMS) {
    const { location, tags: tagNames, ...rest } = item;
    await api('/api/v1/entities', {
      method: 'POST',
      body: JSON.stringify({ ...rest, entityTypeId: itemType.id, parentId: idOf(locations, location), tagIds: tagNames.map((name) => idOf(tags, name)) }),
    });
  }
}
