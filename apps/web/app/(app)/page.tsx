'use client';

import Link from 'next/link';
import { Page } from '@/components/ui';
import { useCan, useSession } from '@/lib/session';

const TILES: [string, string, string][] = [
  ['/walk-in', 'Walk-in', 'leads:write'],
  ['/quick-bill', 'Quick bill', 'quickbill:create'],
  ['/leads/pipeline', 'Pipeline', 'leads:read'],
  ['/leads?view=followups_due', 'Follow-ups due', 'leads:read'],
  ['/sales/orders', 'Quotes & orders', 'sales:read'],
  ['/purchasing/receipts', 'Inward & QC', 'grn:write'],
  ['/stock', 'Stock', 'stock:read'],
  ['/payments', 'Payments', 'payments:read'],
  ['/dashboards/sales', 'Sales dashboard', 'dashboard:sales'],
  ['/dashboards/marketing', 'Marketing dashboard', 'dashboard:marketing'],
  ['/dashboards/accounts', 'Accounts dashboard', 'dashboard:accounts'],
];

export default function Home() {
  const { user } = useSession();
  const can = useCan();
  return (
    <Page title={`Hello, ${user.name}`}>
      {/* Store screens are at most two taps away (PRD section 9). */}
      <div className="home-tiles">
        {TILES.filter(([, , perm]) => can(perm)).map(([href, label]) => <Link key={href} href={href}>{label}</Link>)}
      </div>
    </Page>
  );
}
