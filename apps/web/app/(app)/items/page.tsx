'use client';

import { ProductList } from '@/components/products';
import { Page } from '@/components/ui';

/** Stores → Products: the product master, as picture cards or a list. */
export default function ProductsPage() {
  return (
    <Page title="Products">
      <p className="muted">Everything we buy, make and sell, kept once: every bill, order, purchase and stock screen reads it from here.</p>
      <ProductList />
    </Page>
  );
}
