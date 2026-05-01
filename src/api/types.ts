/**
 * Wire types from perch-api. Hand-maintained for Phase 1.7.
 *
 * Long term these should be generated from perch-api's OpenAPI spec
 * (src/config/swagger.ts) or imported from a shared `@perch/api-types`
 * package. For now, mirror only the fields we surface in tools.
 */

export interface Account {
  id: string;
  name: string;
  isDefault: boolean;
  currentBalance: number;
  isPlaidLinked: boolean;
  autoSyncBalance: boolean;
  lastBalanceUpdate: string | null;
  createdAt: string;
  updatedAt: string;
}

export type Frequency = 'daily' | 'weekly' | 'monthly' | 'yearly';
export type SeriesDirection = 'income' | 'expense';
export type SeriesStatus = 'active' | 'paused' | 'ended';

/**
 * As returned by GET /api/v1/accounts/:accountId/series — perch-api's
 * SeriesSyncItem shape. We intentionally pass through only the fields
 * an LLM (and a chart) actually need.
 */
export interface Series {
  id: string;
  accountId: string;
  startDate: string;          // ISO date
  amount: number;
  description: string;
  frequency: number;          // 0=daily, 1=weekly, 2=monthly, 3=yearly
  interval: number;
  endKind: number;            // 0=never, 1=untilDate, 2=count
  endDate: string | null;
  endCount: number | null;
  status: SeriesStatus;
  direction: SeriesDirection;
  merchantLogoUrl: string | null;
}

const FREQUENCY_LABELS: Record<number, Frequency> = {
  0: 'daily',
  1: 'weekly',
  2: 'monthly',
  3: 'yearly',
};

export function frequencyLabel(frequency: number): Frequency | 'unknown' {
  return FREQUENCY_LABELS[frequency] ?? 'unknown';
}
