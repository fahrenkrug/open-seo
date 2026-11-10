import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  UmamiReportingService,
  type UmamiUtmCampaignsInput,
} from "./UmamiReportingService";
import type { UmamiClient } from "@/server/lib/umamiClient";

type Range = { startAt: number; endAt: number };

const mocks = vi.hoisted(() => ({
  openConnection: vi.fn(),
  getStats: vi.fn(),
  getUtmBreakdown: vi.fn<UmamiClient["getUtmBreakdown"]>(),
  getSeries:
    vi.fn<
      (
        websiteId: string,
        range: Range,
        input: { unit: string; timeZone: string; referrer?: string },
      ) => Promise<unknown>
    >(),
  getExpandedMetrics:
    vi.fn<
      (
        websiteId: string,
        range: Range,
        input: { type: string; limit: number; offset: number },
      ) => Promise<unknown>
    >(),
}));

vi.mock("@/server/features/umami/services/UmamiService", () => ({
  UmamiService: { openConnection: mocks.openConnection },
}));

function metric(name: string, visits: number, extra = {}) {
  return {
    name,
    visits,
    visitors: visits,
    pageviews: visits,
    bounces: 0,
    totaltime: 0,
    ...extra,
  };
}

describe("UmamiReportingService", () => {
  beforeEach(() => {
    mocks.openConnection.mockResolvedValue({
      connection: {
        websiteId: "w1",
        websiteName: "Site",
        websiteDomain: "a.com",
        timeZone: "Europe/Amsterdam",
      },
      instance: { baseUrl: "https://stats.example.com" },
      client: {
        getStats: mocks.getStats,
        getSeries: mocks.getSeries,
        getExpandedMetrics: mocks.getExpandedMetrics,
        getUtmBreakdown: mocks.getUtmBreakdown,
      },
    });
    mocks.getSeries.mockResolvedValue({ pageviews: [], sessions: [] });
    mocks.getExpandedMetrics.mockResolvedValue([]);
    mocks.getUtmBreakdown.mockResolvedValue([]);
  });

  it("reads whole local days across a DST change and zero-fills the trend", async () => {
    mocks.getSeries.mockResolvedValue({
      pageviews: [{ x: "2026-10-25T00:00:00Z", y: 7 }],
      sessions: [{ x: "2026-10-25T00:00:00Z", y: 3 }],
    });

    const result = await UmamiReportingService.getOverview(
      { projectId: "p1" },
      { now: new Date("2026-10-30T12:00:00Z") },
    );

    expect(result.request.resolvedDateRange).toEqual({
      startDate: "2026-10-02",
      endDate: "2026-10-29",
    });
    // Amsterdam is UTC+2 on Oct 2 and UTC+1 after Oct 25.
    expect(mocks.getSeries.mock.calls[0][1]).toEqual({
      startAt: Date.parse("2026-10-01T22:00:00Z"),
      endAt: Date.parse("2026-10-29T23:00:00Z") - 1,
    });
    expect(result.trend).toHaveLength(28);
    // Under the organic filter only entry pageviews match, so the trend
    // carries visitors and leaves pageviews to the totals.
    expect(result.trend.find((day) => day.date === "2026-10-25")).toEqual({
      date: "2026-10-25",
      visitors: 3,
      pageviews: null,
    });
  });

  it("takes organic totals from Umami's per-visit organicSearch channel", async () => {
    mocks.getExpandedMetrics.mockResolvedValue([
      metric("direct", 50),
      metric("organicSearch", 4, { pageviews: 12, bounces: 1, totaltime: 400 }),
    ]);

    const result = await UmamiReportingService.getOverview({ projectId: "p1" });

    expect(mocks.getStats).not.toHaveBeenCalled();
    expect(result.current).toEqual({
      visits: 4,
      visitors: 4,
      pageviews: 12,
      bounceRate: 0.25,
      avgVisitDurationSeconds: 100,
    });
  });

  it("limits organic entry pages to search-engine referrers", async () => {
    await UmamiReportingService.getOverview({ projectId: "p1" });

    const filter = mocks.getSeries.mock.calls[0][2].referrer;
    if (typeof filter !== "string") throw new Error("expected a filter");
    expect(filter.startsWith("re.")).toBe(true);
    // Umami runs it as a case-insensitive Postgres or RE2 regex.
    const search = new RegExp(filter.slice(3), "i");
    for (const domain of [
      "google.com",
      "www.google.co.th",
      "cn.bing.com",
      "uk.search.yahoo.com",
      "search.brave.com",
      "duckduckgo.com",
      "com.google.android.googlequicksearchbox",
    ]) {
      expect(search.test(domain), domain).toBe(true);
    }
    for (const domain of [
      "gemini.google.com",
      "news.google.com",
      "mail.google.com",
      "chatgpt.com",
      "example.com",
    ]) {
      expect(search.test(domain), domain).toBe(false);
    }
  });

  it("asks for a monthly trend once Umami would stop answering daily", async () => {
    mocks.getSeries.mockResolvedValue({
      pageviews: [],
      sessions: [{ x: "2026-03-01T00:00:00Z", y: 40 }],
    });

    const result = await UmamiReportingService.getOverview({
      projectId: "p1",
      startDate: "2026-01-01",
      endDate: "2026-09-30",
    });

    expect(mocks.getSeries.mock.calls[0][2].unit).toBe("month");
    expect(result.request.trend).toBe("monthly");
    expect(result.trend.map((row) => row.date)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
    ]);
    expect(result.trend[2].visitors).toBe(40);
  });

  it("pages entry pages with one look-ahead row", async () => {
    mocks.getExpandedMetrics.mockResolvedValue([
      metric("/a", 5),
      metric("/b", 3),
    ]);

    const result = await UmamiReportingService.runReport({
      projectId: "p1",
      kind: "landing_pages",
      limit: 1,
    });

    expect(result.rows).toEqual([
      { landingPage: "/a", visits: 5, visitors: 5 },
    ]);
    expect(result.pageInfo).toEqual({ limit: 1, offset: 0, hasMore: true });
    expect(mocks.getExpandedMetrics.mock.calls[0][2]).toMatchObject({
      type: "entry",
      limit: 2,
      offset: 0,
    });
  });

  // Umami's channel route ignores limit and offset and returns every channel.
  it("pages the unfiltered channel split itself", async () => {
    mocks.getExpandedMetrics.mockResolvedValue([
      metric("direct", 9),
      metric("organicSearch", 5),
      metric("referral", 2),
    ]);

    const result = await UmamiReportingService.runReport({
      projectId: "p1",
      kind: "channels",
      channel: "organic_search",
      limit: 1,
      offset: 1,
    });

    expect(result.request.channel).toBe("all");
    expect(result.rows).toEqual([
      { channel: "organicSearch", visits: 5, visitors: 5, pageviews: 5 },
    ]);
    expect(result.pageInfo.hasMore).toBe(true);
    expect(mocks.getExpandedMetrics.mock.calls[0][2]).not.toHaveProperty(
      "referrer",
    );
  });

  it("compares exact UTM groups, ranks by visits and keeps partially tagged traffic", async () => {
    const email = {
      utm_source: "newsletter",
      utm_medium: "email",
      utm_campaign: "launch",
    };
    const social = {
      utm_source: "linkedin",
      utm_medium: "social",
      utm_campaign: "launch",
    };
    mocks.getUtmBreakdown
      .mockResolvedValueOnce([
        {
          dimensions: {
            utm_source: null,
            utm_medium: null,
            utm_campaign: null,
          },
          visits: 1_000,
          visitors: 900,
        },
        { dimensions: social, visits: 8, visitors: 6 },
        { dimensions: email, visits: 12, visitors: 3 },
        {
          dimensions: {
            utm_source: "partner",
            utm_medium: null,
            utm_campaign: null,
          },
          visits: 2,
          visitors: 2,
        },
      ])
      .mockResolvedValueOnce([
        { dimensions: social, visits: 4, visitors: 3 },
        { dimensions: email, visits: 10, visitors: 7 },
      ]);

    const result = await UmamiReportingService.getUtmCampaigns({
      projectId: "p1",
      startDate: "2026-10-01",
      endDate: "2026-10-28",
    });

    expect(result.rows.map((row) => row.dimensions.utm_source)).toEqual([
      "newsletter",
      "linkedin",
      "partner",
    ]);
    expect(result.rows[0]).toMatchObject({
      current: { visits: 12, visitors: 3 },
      previous: { visits: 10, visitors: 7 },
      comparison: {
        visits: { absoluteChange: 2, percentChange: 0.2 },
        visitors: { absoluteChange: -4, percentChange: -4 / 7 },
      },
    });
    expect(result.rows[1].previous).toEqual({ visits: 4, visitors: 3 });
    expect(result.rows[2].previous).toEqual({ visits: 0, visitors: 0 });
    expect(result.rows[2].comparison.visits.percentChange).toBeNull();
    expect(result.request.previousDateRange).toEqual({
      startDate: "2026-09-03",
      endDate: "2026-09-30",
    });
    expect(mocks.getUtmBreakdown.mock.calls[1][1]).toEqual({
      startAt: Date.parse("2026-09-02T22:00:00Z"),
      endAt: Date.parse("2026-09-30T22:00:00Z") - 1,
    });
  });

  it("marks capped comparisons unknown and pages the fetched campaigns by visits", async () => {
    mocks.getUtmBreakdown
      .mockResolvedValueOnce(
        Array.from({ length: 500 }, (_, index) => ({
          dimensions: { utm_campaign: `campaign-${index}` },
          visits: index + 1,
          visitors: 1,
        })),
      )
      .mockResolvedValueOnce(
        Array.from({ length: 500 }, (_, index) => ({
          dimensions: {
            utm_campaign: index === 0 ? "campaign-498" : `old-${index}`,
          },
          visits: 10,
          visitors: 5,
        })),
      );

    const result = await UmamiReportingService.getUtmCampaigns({
      projectId: "p1",
      dimensions: ["utm_campaign"],
      limit: 2,
    });

    expect(result.rows[0]).toMatchObject({
      dimensions: { utm_campaign: "campaign-499" },
      previous: { visits: null, visitors: null },
      comparison: { visits: { absoluteChange: null, percentChange: null } },
    });
    expect(result.rows[1].previous).toEqual({ visits: 10, visitors: 5 });
    expect(result.pageInfo).toEqual({ limit: 2, offset: 0, hasMore: true });
    expect(result.coverage).toEqual({
      current: { fetchedRows: 500, complete: false },
      previous: { fetchedRows: 500, complete: false },
    });
    expect(result.warnings).toEqual([
      "utm_current_report_capped",
      "utm_previous_report_capped",
    ]);
    expect(mocks.getUtmBreakdown.mock.calls[0][2].dimensions).toEqual([
      "utm_campaign",
    ]);
  });

  it("keeps absent and explicitly empty UTM dimensions in separate comparison groups", async () => {
    const absent = {
      utm_source: "email",
      utm_medium: null,
      utm_campaign: "launch",
    };
    const empty = { ...absent, utm_medium: "" };
    mocks.getUtmBreakdown
      .mockResolvedValueOnce([
        { dimensions: absent, visits: 10, visitors: 5 },
        { dimensions: empty, visits: 8, visitors: 4 },
      ])
      .mockResolvedValueOnce([
        { dimensions: empty, visits: 6, visitors: 3 },
        { dimensions: absent, visits: 2, visitors: 1 },
      ]);

    const result = await UmamiReportingService.getUtmCampaigns({
      projectId: "p1",
    });

    expect(
      result.rows.map(({ dimensions, previous }) => ({ dimensions, previous })),
    ).toEqual([
      { dimensions: absent, previous: { visits: 2, visitors: 1 } },
      { dimensions: empty, previous: { visits: 6, visitors: 3 } },
    ]);
  });

  it.each<Partial<UmamiUtmCampaignsInput>>([
    { dimensions: [] },
    { dimensions: ["utm_campaign", "utm_campaign"] },
    { limit: 0 },
    { offset: -1 },
    { startDate: "2026-02-30", endDate: "2026-03-01" },
    { startDate: "2026-10-01" },
  ])(
    "rejects invalid UTM report input before requesting analytics: %j",
    async (input) => {
      await expect(
        UmamiReportingService.getUtmCampaigns({ projectId: "p1", ...input }),
      ).rejects.toMatchObject({ code: "validation_error" });
      expect(mocks.getUtmBreakdown).not.toHaveBeenCalled();
    },
  );
});
