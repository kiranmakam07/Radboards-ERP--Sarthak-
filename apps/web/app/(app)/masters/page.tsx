'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmployeesMaster, PartiesMaster } from '@/components/masters';
import { ProductList } from '@/components/products';
import { Loading, Page, Stat, date } from '@/components/ui';
import { useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

const TABS = ['Products', 'Customers', 'Suppliers', 'Employees'] as const;
type Tab = (typeof TABS)[number];

/**
 * Masters: the records the rest of the system is built on. An item, a customer, a supplier or an
 * employee is entered here once; billing, stock, purchasing, accounts, payroll, attendance and
 * tasks all read the same record, so a change made here shows everywhere at once.
 */
export default function MastersPage() {
  const can = useCan();
  const [tab, setTab] = useState<Tab>('Products');
  const { data, loading, error, reload } = useGet<{ data: any }>('/masters/summary');
  const s = data?.data;
  const changed = (at: string | null) => (at ? `last changed ${date(at.slice(0, 10))}` : 'none yet');

  return (
    <Page title="Masters" actions={<a className="button primary" href="/api/masters/export">Download all masters (Excel)</a>}>
      <p className="muted">
        Everything the other screens depend on is kept here, once. Billing, stock, purchasing, the books, payroll, attendance and tasks all read
        these records, so a change made here shows everywhere straight away. Only an admin can change them, unless one is handed to another
        role under <Link href="/admin/permissions">Permissions</Link>. A bill that has already been issued keeps the name, price and tax it was issued with.
      </p>
      <Loading loading={loading && !s} error={error} />
      {s && (
        <div className="stats">
          <Stat label="Products" value={s.items} hint={`${s.items_inactive ? `${s.items_inactive} switched off · ` : ''}${changed(s.items_changed_at)}`} />
          <Stat label="Customers and dealers" value={s.customers} hint={changed(s.customers_changed_at)} />
          <Stat label="Suppliers" value={s.suppliers} hint={changed(s.suppliers_changed_at)} />
          <Stat label="Employees" value={s.employees} hint={`${s.employees_left ? `${s.employees_left} have left · ` : ''}${changed(s.employees_changed_at)}`} />
        </div>
      )}
      <div className="filters">
        {TABS.map((t) => <button key={t} type="button" className={tab === t ? 'primary' : undefined} onClick={() => setTab(t)}>{t}</button>)}
      </div>
      {tab === 'Products' && <ProductList embedded />}
      {tab === 'Customers' && <PartiesMaster key="customers" side="customers" onChange={reload} />}
      {tab === 'Suppliers' && <PartiesMaster key="suppliers" side="suppliers" onChange={reload} />}
      {tab === 'Employees' && (can('employees:manage') || can('hr:read')
        ? <EmployeesMaster onChange={reload} />
        : <p className="muted">The employee list is open to HR and to whoever keeps the employee master.</p>)}
      <p className="muted small" style={{ marginTop: 16 }}>
        The smaller lists (item categories, stock locations, price lists, lead sources, reasons a lead is lost, expense heads) are on{' '}
        <Link href="/admin">Setup</Link>. The chart of accounts is under Books &amp; reports.
      </p>
    </Page>
  );
}
