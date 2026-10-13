/**
 * @radcore/shared: the rules the API and the screens must agree on, kept in one place so that
 * a total shown on a screen is worked out by the same code that the API saves it with.
 *
 *   money      decimal arithmetic and rounding (never floating point), INR formatting, amount in words
 *   gst        GSTIN checks, place of supply, tax on a line and totals of a document
 *   util       phone numbers, dates and the financial year, recurring-task and leave arithmetic
 *   constants  every fixed list (roles, stages, statuses, units) and the permission table
 *   payroll    how a month's salary is worked out
 *   tds        PAN checks and tax deducted at source
 *
 * No database and no screens here: only plain functions, tested in test/shared.test.ts.
 */
export * from './money';
export * from './gst';
export * from './util';
export * from './constants';
export * from './payroll';
export * from './tds';
