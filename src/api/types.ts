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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/scheduled-items

export interface ScheduledItem {
  seriesId: string;
  occursOn: string;            // YYYY-MM-DD
  amount: string;              // signed decimal string
  description: string;
  direction: 'income' | 'expense' | 'transfer' | 'refund';
  frequency: Frequency;
  isPaid: boolean;
  /**
   * ISO-8601 timestamp of when this occurrence was marked paid, or null
   * when it isn't paid. Answers "when did I last mark this paid?".
   */
  paidAt: string | null;
  isRescheduled: boolean;
}

export interface ScheduledItemsResponse {
  accountId: string;
  from: string;
  to: string;
  items: ScheduledItem[];
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/forecast/curve  +  POST /api/v1/forecast/simulate

export type Granularity = 'daily' | 'event';

export interface ForecastEvent {
  seriesId: string;
  amount: string;       // signed decimal string
  description: string;
}

export interface ForecastPoint {
  date: string;             // YYYY-MM-DD
  projectedBalance: string; // signed decimal string, end-of-day
  events: ForecastEvent[];
}

export interface ForecastCurveResponse {
  accountId: string;
  startingBalance: string;
  startingAt: string;
  granularity: Granularity;
  points: ForecastPoint[];
}

export interface ForecastSimulateResponse extends ForecastCurveResponse {
  appliedHypotheticals: number;
}

export interface HypotheticalItem {
  occursOn: string;       // YYYY-MM-DD
  amount: string;         // signed decimal string, e.g. "-500.00"
  description: string;
}
