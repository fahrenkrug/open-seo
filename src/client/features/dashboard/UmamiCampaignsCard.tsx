import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { CardShell } from "@/client/components/CardShell";
import { percentChange } from "@/client/components/MetricsTable";
import { SkeletonTableRows } from "@/client/components/SkeletonPresets";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/components/ui/table";
import { moreDetailsClass } from "@/client/features/dashboard/cardParts";
import { formatCount } from "@/client/features/search-performance/SearchPerformanceColumns";
import { getUmamiCampaignDashboardReport } from "@/serverFunctions/umami";

export function UmamiCampaignsCard({ projectId }: { projectId: string }) {
  const reportQuery = useQuery({
    queryKey: ["dashboardUmamiCampaigns", projectId],
    queryFn: () => getUmamiCampaignDashboardReport({ data: { projectId } }),
  });
  const report = reportQuery.data;

  return (
    <CardShell
      title="Campaigns"
      action={
        <Link
          to="/p/$projectId/settings/integrations"
          params={{ projectId }}
          hash="umami"
          className={moreDetailsClass}
        >
          Manage
        </Link>
      }
    >
      <p className="mb-4 text-sm text-muted-foreground">
        Umami
        {report?.status === "ok" ? ` · ${report.websiteName}` : ""} · Last 28
        days
      </p>
      {reportQuery.isError ? (
        <p className="text-sm text-muted-foreground">
          Couldn&rsquo;t load Umami campaigns. Try again shortly.
        </p>
      ) : !report ? (
        <SkeletonTableRows rows={5} columns={3} />
      ) : report.status === "not_connected" ? (
        <p className="text-sm text-muted-foreground">
          Umami is no longer connected for this project.
        </p>
      ) : report.status === "error" ? (
        <p className="text-sm text-muted-foreground">{report.error.message}</p>
      ) : (
        <>
          {report.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No campaign visits recorded in the last 28 days yet. Add
              utm_campaign to your campaign links to see them here.
            </p>
          ) : (
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-1/2">Campaign</TableHead>
                  <TableHead className="text-right">Visits</TableHead>
                  <TableHead
                    className="text-right"
                    title="Compared with the previous 28 days"
                  >
                    Change
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.rows.map((row) => {
                  const change = percentChange(row.visits, row.previousVisits);
                  const isNew = row.previousVisits === 0 && row.visits > 0;
                  return (
                    <TableRow key={row.campaign}>
                      <TableCell className="[overflow-wrap:anywhere]">
                        {row.campaign}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCount(row.visits)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <span
                          className={
                            isNew || (change !== null && change > 0)
                              ? "text-green-700 dark:text-success"
                              : change !== null && change < 0
                                ? "text-red-700 dark:text-destructive"
                                : "text-muted-foreground"
                          }
                        >
                          {isNew
                            ? "New"
                            : change === null
                              ? "—"
                              : `${change > 0 ? "+" : ""}${change}%`}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {report.truncated ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Partial data: some campaigns may be missing. A dash means the
              previous period is unavailable.
            </p>
          ) : null}
        </>
      )}
    </CardShell>
  );
}
