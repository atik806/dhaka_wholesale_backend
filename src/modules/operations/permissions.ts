import { SetMetadata } from '@nestjs/common';
export const PERMISSION_KEY = 'admin_permission';
export const Permission = (permission: string) =>
  SetMetadata(PERMISSION_KEY, permission);
export const GROUPS = [
  'owner',
  'orders',
  'inventory',
  'support',
  'finance',
] as const;
export const GROUP_PERMISSIONS: Record<string, string[]> = {
  owner: ['*'],
  orders: ['orders.read', 'orders.manage', 'shipments.manage', 'activity.read'],
  inventory: [
    'inventory.read',
    'inventory.manage',
    'products.manage',
    'activity.read',
  ],
  support: [
    'orders.read',
    'orders.notes',
    'returns.read',
    'returns.request',
    'activity.read',
    'support.manage',
  ],
  finance: [
    'orders.read',
    'returns.read',
    'refunds.approve',
    'refunds.complete',
    'reports.read',
    'activity.read',
  ],
};
export function permissionsFor(groups: string[]): string[] {
  return [
    ...new Set(groups.flatMap((group) => GROUP_PERMISSIONS[group] ?? [])),
  ];
}
export function allows(permissions: string[], permission: string): boolean {
  return permissions.includes('*') || permissions.includes(permission);
}
/** Existing endpoints are covered too; unknown admin routes require an owner. */
export function legacyPermission(path: string, method: string): string {
  const route = path.replace(/^\/api/, '').split('?')[0];
  if (/^\/admin\/orders/.test(route)) {
    if (method === 'DELETE') return '*';
    if (/\/payment$/.test(route)) return 'refunds.complete';
    return method === 'GET' ? 'orders.read' : 'orders.manage';
  }
  if (/^\/(products|categories|upload)(\/|$)/.test(route))
    return 'products.manage';
  if (/^\/admin\/(reviews|contact-messages|bug-reports)/.test(route))
    return 'support.manage';
  return '*';
}
