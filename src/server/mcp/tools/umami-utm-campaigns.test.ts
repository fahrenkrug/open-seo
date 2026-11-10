import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createUmamiClient } from "@/server/lib/umamiClient";
import { createOpenSeoMcpServer } from "@/server/mcp/server";
import { createWorkersOAuthMcpProps } from "@/server/mcp/context";
import { getUmamiUtmCampaignsTool } from "./umami-analytics-tools";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(),
  openConnection: vi.fn(),
  getProjectForOrganization: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
  waitUntil: vi.fn(),
  DurableObject: class {
    readonly ctx = null;
  },
}));
vi.mock("@/server/features/activation/mcpActivation", () => ({
  recordExternalMcpToolCall: vi.fn(async () => {}),
}));
vi.mock("@/server/lib/self-host-telemetry", () => ({
  incrementSelfHostMcpToolCallCount: vi.fn(async () => {}),
}));
vi.mock("@/server/lib/posthog", () => ({
  captureServerError: vi.fn(),
  captureServerEvent: vi.fn(async () => {}),
}));
vi.mock("@/server/lib/audit/url-policy", () => ({
  normalizeAndValidateStartUrl: async (url: string) => url,
}));
vi.mock("@/server/features/umami/services/UmamiService", () => ({
  UmamiService: { openConnection: mocks.openConnection },
}));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

const context = makeToolContext();
const args = getUmamiUtmCampaignsTool.config.inputSchema.parse({
  projectId: "project_1",
  startDate: "2026-10-01",
  endDate: "2026-10-28",
  dimensions: ["utm_source", "utm_medium", "utm_campaign", "utm_content"],
});

// Exercise the real tool, reporting service, and HTTP client. Only the saved
// connection and Umami's HTTP responses are replaced.
describe("Umami UTM campaigns MCP tool", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.fetch.mockImplementation(async () => Response.json([]));
    mocks.getProjectForOrganization.mockResolvedValue({ id: "project_1" });
    mocks.openConnection.mockResolvedValue({
      connection: {
        websiteId: "w1",
        websiteName: "Site",
        websiteDomain: "example.com",
        timeZone: "UTC",
      },
      instance: { baseUrl: "https://api.umami.is/v1" },
      client: createUmamiClient({
        baseUrl: "https://api.umami.is/v1",
        authType: "api_key",
        username: null,
        secret: "test-api-key",
        headers: [],
      }),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("returns grouped visits and visitors from Umami responses with the previous-period comparison", async () => {
    mocks.fetch.mockImplementation(async (_input, init) => {
      if (typeof init?.body !== "string")
        throw new Error("Expected a JSON report request");
      const current = init.body.includes("2026-10-01");
      return Response.json([
        {
          utmSource: "newsletter",
          utmMedium: "email",
          utmCampaign: "autumn_launch",
          utmContent: "header",
          views: current ? 100 : 50,
          visits: current ? 12 : 8,
          visitors: current ? 10 : 7,
          bounces: 0,
          totaltime: 100,
        },
      ]);
    });

    const server = createOpenSeoMcpServer(
      createWorkersOAuthMcpProps(context.auth),
    );
    const client = new Client({ name: "umami-campaigns-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const catalog = await client.listTools();
      expect(
        catalog.tools.some((tool) => tool.name === "get_umami_utm_campaigns"),
      ).toBe(true);
      const result = await client.callTool({
        name: "get_umami_utm_campaigns",
        arguments: args,
      });

      expect(result.structuredContent).toMatchObject({
        status: "ok",
        request: {
          dimensions: args.dimensions,
          resolvedDateRange: { startDate: "2026-10-01", endDate: "2026-10-28" },
          previousDateRange: { startDate: "2026-09-03", endDate: "2026-09-30" },
        },
        rows: [
          {
            dimensions: {
              utm_source: "newsletter",
              utm_medium: "email",
              utm_campaign: "autumn_launch",
              utm_content: "header",
            },
            current: { visits: 12, visitors: 10 },
            previous: { visits: 8, visitors: 7 },
            comparison: { visits: { absoluteChange: 4, percentChange: 0.5 } },
          },
        ],
      });
      expect(
        getUmamiUtmCampaignsTool.config.outputSchema.safeParse(
          result.structuredContent,
        ).success,
      ).toBe(true);
      expect(textContent(result)).toContain("autumn_launch");
      expect(textContent(result)).toContain("50.0%");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns an empty successful report when no tagged traffic is recorded", async () => {
    const result = await getUmamiUtmCampaignsTool.handler(args, context);

    expect(result.structuredContent).toMatchObject({
      status: "ok",
      rowCount: 0,
      rows: [],
      pageInfo: { hasMore: false },
    });
    expect(textContent(result)).toContain("0 groups");
  });

  it("keeps absent and explicitly empty tags distinguishable in the text table", async () => {
    mocks.fetch.mockImplementation(async () =>
      Response.json(
        [null, ""].map((content) => ({
          utmSource: "newsletter",
          utmMedium: "email",
          utmCampaign: "launch",
          utmContent: content,
          visits: 3,
          visitors: 2,
        })),
      ),
    );

    const result = await getUmamiUtmCampaignsTool.handler(args, context);

    expect(textContent(result)).toContain("(not set)");
    expect(textContent(result)).toContain("(empty)");
  });

  it("turns rejected Umami credentials into the shared actionable error envelope", async () => {
    mocks.fetch.mockImplementation(
      async () => new Response(null, { status: 401 }),
    );

    const result = await getUmamiUtmCampaignsTool.handler(args, context);

    expect(result.structuredContent).toMatchObject({
      status: "error",
      error: {
        code: "umami_auth_failed",
        actionUrl: "https://open-seo.test/p/project_1/settings/integrations",
      },
    });
  });

  it("denies another organization's project before opening its analytics connection", async () => {
    mocks.getProjectForOrganization.mockResolvedValue(null);

    await expect(
      getUmamiUtmCampaignsTool.handler(args, context),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.openConnection).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
