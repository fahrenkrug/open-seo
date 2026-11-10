# Umami analytics

Sites that use Umami instead of Google Analytics, often because Umami is
cookieless and needs no consent banner, can connect an Umami website to a
project. The dashboard, the chat, and the MCP tools then read its organic
traffic the way they read a GA4 property. UTM campaign reports also show which
tagged sources, media and campaigns bring visits and visitors.

## How it works

An Umami login (server URL, an API key or a username and password, and
optional request headers) is saved once per organization, owned by whoever last
entered its credentials. Each project then points at one website on a saved
login, so an agency with one Umami server and many client sites enters the
credentials once. Saving the same URL, auth type
and username again replaces the stored secret instead of adding a copy.
Removing a login disconnects every project that reads through it.

The secret and the custom headers are encrypted with the deployment's
`BETTER_AUTH_SECRET`, the same key that encrypts the Google OAuth tokens. They
are decrypted in memory for a request and never returned to the client or an
MCP caller; the client sees the URL, auth type, username, and whether custom
headers exist. A login is checked before it is stored: OpenSEO signs in and
lists the websites, and a failure is shown next to the form.

Password logins call Umami's `/api/auth/login` and use the returned token for
the rest of that request. Tokens are not stored. Umami Cloud uses the
`x-umami-api-key` header against its API URL. The server URL passes the same
outbound URL policy as audit start URLs, and redirects are not followed, so a
login can't be pointed at a private address directly or through a redirect.

Umami websites carry no time zone, so the browser's zone is saved with the
connection when a website is picked. Reports default to the last 28 complete
days in that zone, like the GA4 reports, and convert day boundaries to Umami's
millisecond timestamps with daylight saving accounted for.

Umami has no filter for "came from a search engine", so organic traffic is
read two ways. Totals (visits, visitors, pageviews, bounces, visit time) come
from Umami's per-visit channel report, taking its `organicSearch` row, so they
match the Umami dashboard. Entry pages, referrers and the trend use Umami's
referrer regex filter, anchored to search-engine domains so that subdomains
such as `gemini.google.com` or `news.google.com` don't count. That filter is
event-level and only the entry pageview of a search visit carries the external
referrer, so it counts visits and visitors correctly but not the rest of a
visit; filtered reports leave pageviews out, and pageviews per path are read
across all traffic. Umami v2 has no regex filter and reports totals in a
different shape, so a v2 server is rejected when a website is picked rather
than reporting zeros.

Umami switches a daily series to months once a range spans more than seven
calendar months, so ranges over 180 days ask for a monthly trend and say so.

## UTM campaign reports

`get_umami_utm_campaigns` groups tagged pageview activity by the joint values
of `utm_source`, `utm_medium` and `utm_campaign`. Its `dimensions` input can
select any of those fields plus `utm_content` and `utm_term`. The default
range is the last 28 complete days in the saved connection's time zone, with
an equal-length previous period. UTM reporting includes all channels and
does not send the organic referrer filter.

The report uses Umami's `POST /api/reports/breakdown` calculation endpoint.
Its body contains the website ID, `type: "breakdown"`, date bounds and the
selected camelCase fields in `parameters`, plus matching date bounds and the
time zone in `filters`. The response is an array of groups with `views`,
`visitors` and `visits`. Umami counts distinct session IDs for visitors and
distinct visit IDs for visits within each group. A visitor or visit can belong
to several groups, so summing rows cannot produce a distinct total.

UTM fields are supported from Umami v3.1. The basic traffic reports retain
their v3.0 support. The
[v3.1 field definitions](https://github.com/umami-software/umami/blob/c78ff36db0c82e13c86e5073020472c6546313a3/src/lib/schema.ts)
and [breakdown query](https://github.com/umami-software/umami/blob/c78ff36db0c82e13c86e5073020472c6546313a3/src/queries/sql/reports/getBreakdown.ts)
define this contract. Umami v3.4 added a website-scoped GET endpoint but
[preserves the legacy POST contract](https://github.com/umami-software/umami/blob/559e3c607c23d2c72d9bd4f6481bda428255323c/docs/report-api-migration.md)
without a scheduled removal date. Keeping the POST endpoint supports both
versions.

Both database implementations limit a breakdown to 500 groups, ordered by
visitors and then views. There is no upstream pagination. OpenSEO marks a
period as potentially incomplete when it returns 500 groups. A missing
previous-period group can mean zero activity only when that period is
complete; otherwise its comparison remains unavailable. Any local pagination
applies only to the returned groups, which OpenSEO sorts by visits. Dimension
values retain the distinction between an absent tag (`null`) and an explicitly
empty tag (`""`): PostgreSQL groups these separately, so merging them would
lose the exact prior-period match. Their distinct visit and visitor counts
cannot safely be added. Rows with no non-empty value for any selected
dimension are omitted after checking the raw response size for the 500-group
limit.

The dashboard requests a separate breakdown grouped only by campaign name
and shows five campaigns with visits and the previous-period comparison.
This preserves the distinct visit count for a campaign even when its links
use several sources or media. Campaign-report errors are displayed separately
from the existing organic traffic report.

## Surfaces

- **Settings → Integrations** has an Umami card: add a login, pick a website,
  change it, disconnect the project, or remove a saved login.
- **Dashboard**: an Organic traffic card with visits, visitors, pageviews and
  bounce rate against the previous 28 days, and a daily visitors trend. When a
  project uses Umami and has no GA4 connection, the GA4 connect card is
  hidden. A UTM campaigns section shows visits for five campaign names and
  their previous-period comparisons across all tagged traffic.
- **MCP and chat**: `get_umami_organic_overview`, `get_umami_landing_pages`,
  `get_umami_page_performance` and `get_umami_traffic_sources`. They return the
  same ok/error envelope as the GA4 tools, default to organic search, and take
  `channel: "all"` for every visit.
- **MCP and chat, campaigns**: `get_umami_utm_campaigns` uses the same envelope
  and reports joint UTM groups across all tagged traffic, with visits,
  visitors, previous-period comparisons and any truncation warning.

## Alternatives

Making the GA4 tools source-agnostic would give agents one set of analytics
tools. GA4 and Umami measure different things (sessions, key events and revenue
against visits, visitors and bounces), so a shared schema would either hide
fields or invent them. Separate tools with the same envelope keep each source
honest.

Storing the login per project would be simpler, but agencies run many sites on
one Umami server and would re-enter and rotate the same password in every
project.

Using only Umami's channel grouping would keep every number on one
definition, but Umami exposes channels as a report, not as a filter, so entry
pages and referrers couldn't be limited to search visits. Using only the
referrer filter would keep one definition too, but would report every organic
visit as a one-page bounce.

Umami's dedicated UTM insight returns pageview counts for one dimension at a
time. It cannot provide the visits, visitors or joint source/medium/campaign
groups this report needs. Joining separate ranked lists would invent
relationships between their values, so the report uses the breakdown query's
joint grouping. Summing source/medium rows for the dashboard would also count
some visits more than once; a campaign-only breakdown gives the correct
campaign count.

Caching the login token across requests would save one login call per report.
The token is bound to the user's password and some deployments keep tokens in
Redis with an expiry, so a fresh login is the more predictable choice.

Joining Umami entry pages with Search Console pages into scored opportunities,
as `get_search_opportunities` does for GA4, is left for later.
