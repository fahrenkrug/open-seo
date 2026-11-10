import { inclusiveGa4Days } from "@/server/features/ga4/services/Ga4Dates";
import { sort } from "remeda";
import {
  resolveUmamiDateRange,
  toUmamiTimeRange,
  fillUmamiTrend,
} from "./UmamiDates";
import {
  comparisonValue,
  previousPeriod,
} from "@/server/features/ga4/services/Ga4ReportEnhancements";
import { UmamiService } from "@/server/features/umami/services/UmamiService";
import type { UmamiStats, UmamiTimeRange } from "@/server/lib/umamiClient";
import { UmamiError } from "@/server/lib/umamiErrors";
import {
  umamiUtmDimensionSchema,
  type UmamiUtmDimension,
} from "@/shared/umami";

export type UmamiChannel = "organic_search" | "all";
type UmamiReportKind =
  | "landing_pages"
  | "page_performance"
  | "referrers"
  | "channels";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;

// Umami's referrer filter accepts a `re.` regex (Umami v3+), run as a
// case-insensitive Postgres or ClickHouse (RE2) match, so no lookaheads. The
// filter is event-level: it matches only the entry pageview of a search visit,
// which carries the external referrer. That is right for counting visits and
// visitors per entry page or referrer, and wrong for anything that needs the
// rest of the visit (pageviews, bounces, time), so those come from Umami's own
// per-visit channel report instead. Subdomain labels are limited to www, m,
// search and two-letter regions, so gemini.google.com or news.google.com
// don't count as search.
const ORGANIC_REFERRER_FILTER =
  "re.^((www|m|[a-z]{2})\\.)?(([a-z]{2}\\.)?search\\.)?(google|bing|duckduckgo|ecosia|yandex|baidu|yahoo|qwant|startpage|brave|naver|seznam|msn)\\.|^ya\\.ru$|^com\\.google\\.android\\.googlequicksearchbox";

// Umami's name for search-engine visits in its channel report.
const ORGANIC_CHANNEL = "organicSearch";

// Umami silently switches `unit=day` to months once a range spans more than
// seven calendar months, so longer trends are requested monthly up front.
const MAX_DAILY_TREND_DAYS = 180;

const REPORTS = {
  landing_pages: {
    type: "entry",
    dimension: "landingPage",
    metrics: ["visits", "visitors"],
  },
  page_performance: {
    type: "path",
    dimension: "pagePath",
    metrics: ["pageviews", "visitors", "visits"],
  },
  referrers: {
    type: "referrer",
    dimension: "referrer",
    metrics: ["visits", "visitors"],
  },
  channels: {
    type: "channel",
    dimension: "channel",
    metrics: ["visits", "visitors", "pageviews"],
  },
} as const;

const NO_TRAFFIC: UmamiStats = {
  pageviews: 0,
  visitors: 0,
  visits: 0,
  bounces: 0,
  totaltime: 0,
};

function summarize(stats: UmamiStats) {
  return {
    visits: stats.visits,
    visitors: stats.visitors,
    pageviews: stats.pageviews,
    bounceRate: stats.visits > 0 ? stats.bounces / stats.visits : null,
    avgVisitDurationSeconds:
      stats.visits > 0 ? stats.totaltime / stats.visits : null,
  };
}

const OVERVIEW_METRICS = [
  "visits",
  "visitors",
  "pageviews",
  "bounceRate",
  "avgVisitDurationSeconds",
] as const;

function source(
  connection: {
    websiteId: string;
    websiteName: string;
    websiteDomain: string | null;
  },
  instance: { baseUrl: string },
) {
  return {
    provider: "umami" as const,
    instanceUrl: instance.baseUrl,
    websiteId: connection.websiteId,
    websiteName: connection.websiteName,
    websiteDomain: connection.websiteDomain,
  };
}

async function getOverview(
  input: {
    projectId: string;
    startDate?: string;
    endDate?: string;
    channel?: UmamiChannel;
  },
  opts: { now?: Date } = {},
) {
  const { connection, instance, client } = await UmamiService.openConnection(
    input.projectId,
  );
  const channel = input.channel ?? "organic_search";
  const organic = channel === "organic_search";
  const dateRange = resolveUmamiDateRange(input, connection.timeZone, opts.now);
  const { resolvedDateRange } = dateRange;
  const previousDateRange = previousPeriod(resolvedDateRange);
  const currentRange = toUmamiTimeRange(resolvedDateRange, connection.timeZone);
  const previousRange = toUmamiTimeRange(
    previousDateRange,
    connection.timeZone,
  );
  const unit =
    inclusiveGa4Days(resolvedDateRange.startDate, resolvedDateRange.endDate) >
    MAX_DAILY_TREND_DAYS
      ? "month"
      : "day";

  // Organic totals are Umami's own per-visit organicSearch channel, so
  // pageviews, bounces and time cover the whole visit.
  const totals = async (range: UmamiTimeRange): Promise<UmamiStats> => {
    if (!organic) return client.getStats(connection.websiteId, range);
    const channels = await client.getExpandedMetrics(
      connection.websiteId,
      range,
      { type: "channel", limit: MAX_LIMIT, offset: 0 },
    );
    return channels.find((row) => row.name === ORGANIC_CHANNEL) ?? NO_TRAFFIC;
  };

  const [currentStats, previousStats, series] = await Promise.all([
    totals(currentRange),
    totals(previousRange),
    client.getSeries(connection.websiteId, currentRange, {
      unit,
      timeZone: connection.timeZone,
      referrer: organic ? ORGANIC_REFERRER_FILTER : undefined,
    }),
  ]);
  const current = summarize(currentStats);
  const previous = summarize(previousStats);
  return {
    status: "ok" as const,
    source: source(connection, instance),
    request: {
      requestedDateRange: dateRange.requestedDateRange,
      resolvedDateRange,
      previousDateRange,
      timeZone: connection.timeZone,
      channel,
      trend: unit === "day" ? ("daily" as const) : ("monthly" as const),
    },
    current,
    previous,
    comparison: Object.fromEntries(
      OVERVIEW_METRICS.map((metric) => [
        metric,
        comparisonValue(current[metric], previous[metric]),
      ]),
    ),
    trend: fillUmamiTrend(series, resolvedDateRange, unit, !organic),
    warnings: dateRange.warnings,
  };
}

export type UmamiReportInput = {
  projectId: string;
  kind: UmamiReportKind;
  channel?: UmamiChannel;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
};

async function runReport(input: UmamiReportInput) {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const offset = input.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new UmamiError(
      "validation_error",
      `limit must be an integer from 1 to ${MAX_LIMIT}.`,
    );
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new UmamiError(
      "validation_error",
      "offset must be a non-negative integer.",
    );
  }
  const { connection, instance, client } = await UmamiService.openConnection(
    input.projectId,
  );
  const definition = REPORTS[input.kind];
  // The channel report is itself the channel split, and pageviews per path
  // under the organic filter would count only landing hits, so neither is
  // filtered.
  const channel =
    input.kind === "channels" || input.kind === "page_performance"
      ? "all"
      : (input.channel ?? "organic_search");
  const dateRange = resolveUmamiDateRange(input, connection.timeZone);
  const range = toUmamiTimeRange(
    dateRange.resolvedDateRange,
    connection.timeZone,
  );
  const referrer =
    channel === "organic_search" ? ORGANIC_REFERRER_FILTER : undefined;

  // Umami returns no total, so one extra row tells whether another page
  // exists. Its channel report ignores limit and offset and returns every
  // channel, so that one is paged here.
  const metrics =
    input.kind === "channels"
      ? (
          await client.getExpandedMetrics(connection.websiteId, range, {
            type: definition.type,
            limit: MAX_LIMIT,
            offset: 0,
          })
        ).slice(offset, offset + limit + 1)
      : await client.getExpandedMetrics(connection.websiteId, range, {
          type: definition.type,
          limit: limit + 1,
          offset,
          referrer,
        });
  const rows = metrics.slice(0, limit).map((metric) => ({
    [definition.dimension]: metric.name,
    ...Object.fromEntries(
      definition.metrics.map((name) => [name, metric[name]]),
    ),
  }));
  return {
    status: "ok" as const,
    source: source(connection, instance),
    request: {
      reportKind: input.kind,
      requestedDateRange: dateRange.requestedDateRange,
      resolvedDateRange: dateRange.resolvedDateRange,
      timeZone: connection.timeZone,
      channel,
      dimensions: [definition.dimension],
      metrics: [...definition.metrics],
    },
    rowCount: rows.length,
    rows,
    pageInfo: { limit, offset, hasMore: metrics.length > limit },
    warnings: dateRange.warnings,
  };
}

export type UmamiReportResult = Awaited<ReturnType<typeof runReport>>;
export type UmamiOverviewResult = Awaited<ReturnType<typeof getOverview>>;

const UTM_REPORT_LIMIT = 500;
const utmDimensionsSchema = umamiUtmDimensionSchema
  .array()
  .min(1)
  .max(5)
  .refine((dimensions) => new Set(dimensions).size === dimensions.length);

export type UmamiUtmCampaignsInput = {
  projectId: string;
  dimensions?: UmamiUtmDimension[];
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
};

async function getUtmCampaigns(input: UmamiUtmCampaignsInput) {
  const parsedDimensions = utmDimensionsSchema.safeParse(
    input.dimensions ?? ["utm_source", "utm_medium", "utm_campaign"],
  );
  if (!parsedDimensions.success) {
    throw new UmamiError(
      "validation_error",
      "Choose one or more distinct UTM dimensions: source, medium, campaign, content, or term.",
    );
  }
  const dimensions = parsedDimensions.data;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const offset = input.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > UTM_REPORT_LIMIT) {
    throw new UmamiError(
      "validation_error",
      `limit must be an integer from 1 to ${UTM_REPORT_LIMIT}.`,
    );
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new UmamiError(
      "validation_error",
      "offset must be a non-negative integer.",
    );
  }

  const { connection, instance, client } = await UmamiService.openConnection(
    input.projectId,
  );
  const dateRange = resolveUmamiDateRange(input, connection.timeZone);
  const previousDateRange = previousPeriod(dateRange.resolvedDateRange);
  const [currentGroups, previousGroups] = await Promise.all(
    [dateRange.resolvedDateRange, previousDateRange].map((range) =>
      client.getUtmBreakdown(
        connection.websiteId,
        toUmamiTimeRange(range, connection.timeZone),
        { dimensions, timeZone: connection.timeZone },
      ),
    ),
  );
  // Umami returns at most 500 groups, ranked by visitors. A missing prior
  // group is zero only when that response was complete, never when capped.
  const coverage = {
    current: {
      fetchedRows: currentGroups.length,
      complete: currentGroups.length < UTM_REPORT_LIMIT,
    },
    previous: {
      fetchedRows: previousGroups.length,
      complete: previousGroups.length < UTM_REPORT_LIMIT,
    },
  };
  const key = (row: (typeof currentGroups)[number]) =>
    JSON.stringify(dimensions.map((dimension) => row.dimensions[dimension]));
  const previousByKey = new Map(previousGroups.map((row) => [key(row), row]));
  const taggedRows = sort(
    currentGroups.filter((row) =>
      dimensions.some((dimension) => row.dimensions[dimension]),
    ),
    (a, b) => {
      const visits = b.visits - a.visits;
      if (visits !== 0) return visits;
      const aKey = key(a);
      const bKey = key(b);
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    },
  );
  const rows = taggedRows.slice(offset, offset + limit).map((row) => {
    const prior = previousByKey.get(key(row));
    const current = { visits: row.visits, visitors: row.visitors };
    const previous = {
      visits: prior?.visits ?? (coverage.previous.complete ? 0 : null),
      visitors: prior?.visitors ?? (coverage.previous.complete ? 0 : null),
    };
    return {
      dimensions: row.dimensions,
      current,
      previous,
      comparison: {
        visits: comparisonValue(current.visits, previous.visits),
        visitors: comparisonValue(current.visitors, previous.visitors),
      },
    };
  });
  const warnings = [...dateRange.warnings];
  if (!coverage.current.complete) warnings.push("utm_current_report_capped");
  if (!coverage.previous.complete) warnings.push("utm_previous_report_capped");

  return {
    status: "ok" as const,
    source: source(connection, instance),
    request: {
      requestedDateRange: dateRange.requestedDateRange,
      resolvedDateRange: dateRange.resolvedDateRange,
      previousDateRange,
      timeZone: connection.timeZone,
      dimensions,
      metrics: ["visits", "visitors"],
    },
    rows,
    rowCount: rows.length,
    pageInfo: { limit, offset, hasMore: taggedRows.length > offset + limit },
    coverage,
    warnings,
  };
}

export type UmamiUtmCampaignsResult = Awaited<
  ReturnType<typeof getUtmCampaigns>
>;

export const UmamiReportingService = {
  getOverview,
  runReport,
  getUtmCampaigns,
};
