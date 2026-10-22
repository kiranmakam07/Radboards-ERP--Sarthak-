import { STATE_CODES } from '@radcore/shared';
import type { Field } from './ui';

/** `withTerms` is off for someone adding a party while working: the commercial terms belong to the master. */
export const partyFields = (priceLists: any[], withType = true, withTerms = true): Field[] => [
  ...(withType ? [{ name: 'party_type', label: 'Type', type: 'select' as const, required: true,
    options: [{ value: 'customer', label: 'Customer' }, { value: 'dealer', label: 'Dealer' }, { value: 'franchisee', label: 'Franchisee' }, { value: 'supplier', label: 'Supplier' }] }] : []),
  { name: 'name', label: 'Name', required: true },
  { name: 'phone', label: 'Phone', type: 'tel' },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'gstin', label: 'GSTIN', help: 'State is read from the GSTIN' },
  { name: 'pan', label: 'PAN', help: 'For TDS. Not needed when there is a GSTIN' },
  { name: 'state_code', label: 'State (if no GSTIN)', type: 'select', options: Object.entries(STATE_CODES).map(([c, n]) => ({ value: c, label: `${c} ${n}` })) },
  { name: 'line1', label: 'Address' },
  { name: 'city', label: 'City' },
  { name: 'pincode', label: 'Pincode' },
  ...(withTerms ? [
    { name: 'price_list_id', label: 'Price list', type: 'select' as const, options: priceLists.map((p) => ({ value: p.id, label: p.name })) },
    { name: 'credit_limit', label: 'Credit limit ₹', type: 'number' as const },
    { name: 'payment_terms_days', label: 'Payment terms (days)', type: 'number' as const },
  ] : []),
];

export const partyBody = ({ line1, city, pincode, ...v }: Record<string, any>) => ({
  ...v,
  ...(line1 !== undefined || city !== undefined || pincode !== undefined
    ? { billing_address: { line1: line1 ?? '', city: city ?? '', pincode: pincode ?? '' } }
    : {}),
});
