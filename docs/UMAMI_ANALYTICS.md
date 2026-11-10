# Umami analytics

Connect a project to an [Umami](https://umami.is) website to see its organic
traffic and UTM campaigns in OpenSEO's dashboard, chat, and MCP tools. It works
with a self-hosted Umami server and with Umami Cloud. The connection is
read-only.

## What you'll need

- Umami v3 or newer. OpenSEO filters visits by search-engine referrer with
  Umami's regex filter, which v2 doesn't have; a v2 server is rejected when you
  pick a website. UTM campaign reports require Umami v3.1 or newer. The other
  reports continue to work with v3.0.
- For a self-hosted server: a username and password. A view-only Umami user is
  enough, and a dedicated one is the safer choice. Users with two-factor
  sign-in can't be used.
- For Umami Cloud: an API key from **Settings → API keys** in Umami Cloud.
- On a self-hosted OpenSEO deployment: `BETTER_AUTH_SECRET` set to at least 32
  characters. It encrypts the Umami password or API key and any custom headers.
  Hosted OpenSEO already has it.

## Connect a project

1. Open the project's **Settings → Integrations** and find the **Umami** card.
2. Enter the Umami URL, the address you open Umami at, for example
   `https://analytics.example.com`. For Umami Cloud, enter
   `https://cloud.umami.is`.
3. Choose **Username and password (self-hosted)** or **API key (Umami Cloud)**
   and fill in the credentials.
4. If an auth proxy sits in front of Umami, add its headers under **Custom
   request headers**, one `Name: value` per line. For a Cloudflare Access
   service token:

   ```text
   CF-Access-Client-Id: <client id>
   CF-Access-Client-Secret: <client secret>
   ```

5. Select **Sign in and list websites**. OpenSEO signs in and lists the
   websites the login can see. Nothing is saved if the sign-in fails.
6. Pick the website for this project and select **Use this website**.

The login is saved for the organization. In another project, the Umami card
lists it under **Saved Umami logins**; choose **Choose website** to pick that
project's website without entering the credentials again. Saving the same URL
and username again replaces the stored password, for example after a password
change. Removing a saved login disconnects every project that uses it.

Days are counted in the time zone of the browser you picked the website from.
To change it, pick the website again from a browser in the other time zone.

## What OpenSEO reads

| Where                        | What                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| Dashboard, Organic traffic   | Visits, visitors, pageviews and bounce rate from search engines, last 28 complete days.               |
| Dashboard, UTM campaigns     | Five campaigns by name, with visits and a previous-period comparison, last 28 complete days.          |
| `get_umami_organic_overview` | The same totals for any date range against the previous period, with a visitors trend.                |
| `get_umami_landing_pages`    | Entry pages with visits and visitors.                                                                 |
| `get_umami_page_performance` | Pageviews, visitors and visits per page path, across all traffic.                                     |
| `get_umami_traffic_sources`  | Visits by referring domain, or by Umami channel (organic search, direct, referral, and others).       |
| `get_umami_utm_campaigns`    | Visits and visitors for combinations of UTM source, medium and campaign, against the previous period. |

Organic totals are Umami's own **Organic search** channel, so they match the
Umami dashboard. Entry pages, referrers and the trend use the visit's referrer
instead: a visit counts as organic when it arrived from Google, Bing,
DuckDuckGo, Ecosia, Yandex, Baidu, Yahoo, Qwant, Startpage, Brave, Naver,
Seznam or MSN. The two can differ: Umami's channel also counts links tagged
`utm_medium=organic` and any `google.` subdomain, such as Google News, and
leaves out Yahoo, Naver, Seznam, Qwant and Startpage. The organic overview,
landing-page and traffic-source tools take `channel: "all"` to include every
visit, and the chat uses the same tools. The trend is daily, or monthly for
ranges over 180 days.

## UTM campaigns

UTM reports include tagged traffic from all channels, including email, social
and paid campaigns. They do not apply the organic-search filter. Visits and
visitors count activity carrying the selected UTM values; they are not
conversion or revenue metrics.

`get_umami_utm_campaigns` groups by `utm_source`, `utm_medium` and
`utm_campaign` together by default. Each row describes one combination of
those values. Pass a `dimensions` array to choose from `utm_source`,
`utm_medium`, `utm_campaign`, `utm_content` and `utm_term`. For example,
`dimensions: ["utm_campaign"]` compares campaign names, while adding
`utm_content` separates links within a campaign. The tool preserves Umami's
tag values: an absent tag can be `null`, while an explicitly empty tag is
`""`. These remain separate groups when Umami returns them separately. Rows
with no non-empty value for any selected dimension are left out.

The default range is the last 28 complete days in the connection's time zone,
compared with the preceding period of the same length. You can provide both
`startDate` and `endDate` as inclusive `YYYY-MM-DD` dates. The dashboard groups
only by campaign name, so a campaign's visits are counted directly instead of
adding counts from its sources, media or links. One visitor or visit can occur
in several UTM groups, so adding the rows does not give a distinct total.

Umami returns at most 500 groups per period. OpenSEO warns when a period
reaches that limit; additional groups may be missing. If a campaign is absent
from a limited previous-period result, its comparison is unavailable rather
than treated as zero. OpenSEO sorts the returned groups by visits; the
dashboard shows the first five campaign names. Pagination in the MCP tool can
only page through those returned groups.

## Troubleshooting

- **"The Umami URL redirects elsewhere"**: OpenSEO doesn't follow redirects.
  Enter the final URL, including `https://`.
- **"This Umami URL points at a private or reserved address"**: OpenSEO only
  connects to public addresses, so a server on `localhost` or a private network
  can't be reached. Put Umami on a public hostname, behind an auth proxy if you
  want.
- **"The Umami URL did not return JSON"**: usually an auth proxy's sign-in page.
  Add the proxy's headers.
- **"This Umami server runs v2"**: upgrade Umami to v3.
- **UTM campaign reports are unavailable**: check that your Umami server runs
  v3.1 or newer. A campaign-report error does not disconnect the website or
  prevent the existing traffic reports from loading.
- **The card says the saved credentials can no longer be read**: the
  deployment's `BETTER_AUTH_SECRET` changed. Add the login again.
