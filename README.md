# RawDeals

Daily Amazon deals from [Raw0nline](https://linktr.ee/raw0nline) (Eddie). The site is static and is meant to be hosted free on GitHub Pages at [getrawdeals.com](https://getrawdeals.com/).

Real deals on the page come from the daily refresh. Example cards are still in `data/deals.json`, with **Example** in the name, but the page and the email feed hide them.

## Preview on your computer

From this folder:

```bash
python3 -m http.server 4173
```

Open http://127.0.0.1:4173/

Opening `index.html` as a file will not load the deals. The page fetches `data/deals.json`, which needs a local server.

Optional checks, with Node installed and no extra packages:

```bash
node --test
node scripts/validate-deals.js
```

## Add a day's deals

Edit `data/deals.json`. Keep the `about` note until the examples are gone. Each object in `deals` is one card.

```json
{
  "id": "2026-11-10-skillet",
  "title": "10-inch skillet",
  "image": "https://m.media-amazon.com/images/I/example.jpg",
  "price": 29.99,
  "originalPrice": 44.99,
  "percentOff": 33,
  "promoCode": "PAN10",
  "category": "Kitchen",
  "url": "https://www.amazon.com/dp/ASIN_HERE",
  "added": "2026-11-10",
  "expires": "2026-11-12",
  "sample": false
}
```

| Field | Required | What to put |
| --- | --- | --- |
| `id` | yes | A new unique id. A date plus a short name works. |
| `title` | yes | Product name. Do not start real deals with `EXAMPLE`. |
| `image` | yes | A full `https://` image URL (an Amazon image URL is fine) or a file in this repo such as `images/samples/kitchen.svg`. |
| `price` | yes | Current price in dollars, as a number. |
| `originalPrice` | no | List price. Leave the field out if you do not have one. |
| `percentOff` | yes | Whole number. Use `0` when there is no `originalPrice`. |
| `promoCode` | no | Leave the field out when there is no code. The card gets a Copy button only when this is set. |
| `category` | yes | Short label. It becomes a filter chip. |
| `url` | yes | A normal `amazon.com` link. Do not add the Associates tag yourself. |
| `added` | yes | `YYYY-MM-DD` for the day you want the card grouped under. The page treats “today” as the calendar date in `America/Chicago`. |
| `expires` | no | `YYYY-MM-DD`. The card shows “Ends …”. After that date the card is hidden, including hand-written deals. |
| `sample` | yes | `false` for a real deal. `true` is only for placeholders, and those titles must include `EXAMPLE`. |

Put new deals anywhere in the array. The page groups by `added` and shows the newest day first. Within a day, cards stay in the order they appear in the file.

Commit the file and push to `main` (or merge a pull request). GitHub Pages publishes the update. Browsers are asked to revalidate `deals.json`. A refresh a minute or two later should show the new day.

Run `node scripts/validate-deals.js` before you push if you want the file checked.

Deals with `"sample": true` stay in the file. The page and the RSS feed both hide them, so they are not shown as live deals. Delete those objects when you no longer want them in the file.

## Promo codes and the Copy button

The Copy button writes the code to the clipboard and the button label changes to **Copied**. That happens in the visitor’s browser.

## Report dead deal

**Report dead deal** grays that card out and adds a **Dead** label. **Undo report** clears it on that browser.

The gray mark is saved immediately in this browser, under the localStorage key `rawdeals.deadReports.v1`. That part works even if the shared API below is down or not deployed yet. Each saved report looks like:

```json
{ "id": "deal-id", "reportedAt": "2026-11-09T12:00:00.000Z", "source": "local" }
```

The page also sends the report to `https://api.getrawdeals.com`. One browser gets one vote per deal. After **3 different people** report the same deal, a GitHub Action looks the ASIN up with the Creators API. If Amazon says the offer is dead, the card is removed for every visitor, and the next feed build leaves it out of `feed.xml` too. If Amazon says the offer is still good, the card stays up and those reports are cleared for 48 hours.

**Undo report** removes only that browser’s vote. It does not bring back a deal that was already verified dead.

Your own unverified report stays gray only for you. Other people still see the card until the Amazon check agrees it is dead.

The browser id is a random value in localStorage (`rawdeals.visitor.v1`). The API stores a hash of that id and a hash of the IP address. It does not store the raw IP, and it never sees the Amazon credentials.

Limits, so one visitor cannot flag the whole page:

| Limit | Value |
| --- | --- |
| Distinct reporters before an Amazon check | 3 |
| New reports per browser | 4 per hour, 6 per day |
| New reports per network (hashed IP) | 6 per hour, 10 per day |
| Cooldown after Amazon says the deal is still live | 48 hours |
| Price difference that counts as “the price went up” | more than $0.02 above the card |

A repeat tap on a deal you already reported does not use up the limit. Undo does not use it up either.

The Amazon check marks a deal dead when any of these are true:

- the ASIN is missing from the Creators API response
- the offer is out of stock, unavailable, not released yet, or preorder
- there is no buyable price, or the listing violates MAP
- the current price is more than $0.02 above the price on the card
- Amazon’s deal end time is already past

If the price is still at or below the card and the item can be bought, the deal stays. A promo code is not something the API can check, so a working code with the same price is left up. A hand-written deal with no ASIN in its id or in a `/dp/ASIN` link cannot be checked, so it is not hidden for everyone. The browser that reported it still shows it gray.

Checked deals are written back with `verifiedDead: true` and `inStock: false`. `visibleDeals()` then drops them from the page and from `feed.xml`. If a later refresh finds that ASIN on sale again, the shared flag is cleared and the card can come back.

## Shared dead-deal reports (set this up once)

Do this after the pull request is merged. The site keeps working before you finish. Reports stay on the visitor’s browser until the API is up, and the hourly workflow does nothing until the GitHub secret below exists.

The API is a Cloudflare Worker. The Amazon check stays in GitHub Actions, because that is where `CREATORS_API_CREDENTIAL_ID` and `CREATORS_API_CREDENTIAL_SECRET` already live. Do not copy those two secrets into Cloudflare, into a file, or into the browser.

DNS for the site stays as it is. The apex and `www` records stay **DNS only** (gray cloud), pointed at GitHub Pages. Proxying them breaks the GitHub certificate. The Worker gets its own hostname, `api.getrawdeals.com`, and that record is proxied.

### 1. Cloudflare Worker and KV

Use the same Cloudflare account that already has the DNS for getrawdeals.com. From your computer, in this repo:

```bash
cd workers/dead-deals
npx wrangler login
npx wrangler kv namespace create rawdeals-dead-deals
```

The namespace command prints an id. Open `workers/dead-deals/wrangler.toml` and replace `REPLACE_WITH_KV_NAMESPACE_ID` with that id. Commit that id. It is not a secret. Leave the Amazon credentials out of this file.

Create two long random values and do not paste them into the repo, an issue, or a workflow file:

```bash
openssl rand -hex 32
```

Run that twice. The first value is the IP hash salt. The second is the API token. Both must be at least 16 characters. Then, still inside `workers/dead-deals`:

```bash
npx wrangler secret put IP_HASH_SALT
npx wrangler secret put DEAD_DEALS_TOKEN
npx wrangler deploy
```

`IP_HASH_SALT` is what the Worker mixes into the IP hash. If you change it later, existing votes are forgotten and people can report again. `DEAD_DEALS_TOKEN` is how GitHub Actions talks to the admin routes. The public site does not see either value.

In the Cloudflare dashboard, open **Workers & Pages**, then **rawdeals-dead-deals**, then **Settings**, then **Domains & Routes**. Add a custom domain: `api.getrawdeals.com`. Cloudflare creates the DNS record and proxies it. Do not change the apex or `www` records while you do this.

Check the Worker before you give GitHub the token:

```bash
curl -sS -H "X-Visitor-Id: 00000000-0000-4000-8000-000000000001" https://api.getrawdeals.com/api/dead-deals
```

An empty list (`[]`) means it is up. A browser error or a 503 means the salt or the KV binding is missing. Fix that before the next step.

### 2. GitHub Actions secret

The hourly workflow is **Verify dead deals** (`.github/workflows/verify-dead-deals.yml`). It runs at minute 15 of every hour, and you can start it by hand. It uses the Creators API secrets you already have. Add one new secret, and only after the curl above works. If the secret is set while the Worker is down, the hourly run fails.

1. Open the [rawdeals](https://github.com/Raw0nline-Deals/rawdeals) repository on GitHub.
2. Click **Settings**, then **Secrets and variables**, then **Actions**.
3. Under **Repository secrets**, click **New repository secret**.
4. Name it `DEAD_DEALS_TOKEN`. Paste the same token you gave Wrangler. Save it.
5. Do not create new `CREATORS_API_CREDENTIAL_ID` or `CREATORS_API_CREDENTIAL_SECRET` values here if they are already set. Do not put the token in Cloudflare’s Amazon fields. There are no Amazon fields on the Worker.

The API address defaults to `https://api.getrawdeals.com`. You only need a variable if you chose a different hostname: under **Variables**, add `DEAD_DEALS_API_URL`. Also change `DEAD_DEALS_API_ORIGIN` in `js/dead-deals.js` to that same origin, because the static site has no build step.

### 3. Confirm a run

1. Open **Actions**, then **Verify dead deals**, then **Run workflow** on `main`.
2. A green run that says the token is not set means step 2 is not done yet.
3. After the secret is saved, a green run should say there was nothing to check. It does not call Amazon when nobody has reached 3 reports.
4. The daily deal refresh also clears a verified flag when Amazon puts that deal back on the site. That step does nothing until the token exists. If the API is down later, the refresh logs a warning and still rebuilds the feed.

To try the script on your computer without calling Amazon, run `node scripts/verify-dead-deals.js`. With no token in the environment it prints that no request was sent. Do not put the token or the Creators API secrets on the command line. Export them in the shell only if you mean to hit the live API.

## Email signup (Beehiiv)

Under the header, and before the example notice, category filters, and deal list, “How to use a coupon code” explains the three checkout steps. Below the deals, the panel is a working signup form. **Sign Up** checks the address, then opens Beehiiv’s magic link with the email encoded in the query string. RawDeals does not store the address. The link is built in `js/signup.js`.

## Affiliate tag

Every Amazon link the page creates goes through `withAffiliateTag()` in `js/affiliate.js`. That function sets `tag=onamzeddie0c-20` on US Amazon hosts (`amazon.com` and short links such as `amzn.to` and `a.co`) and replaces any other tag already on the link. The storefront link uses it too.

Paste a normal product URL in `url`. The tag is added when the page is drawn. The tag string lives in `js/affiliate.js` so it is not copied through the HTML.

The footer on the page includes: “As an Amazon Associate I earn from qualifying purchases.” It also has a short affiliate disclosure. Both are in `index.html`, so they stay visible with the deal list.

Links:

- Linktree: https://linktr.ee/raw0nline
- Amazon storefront: https://www.amazon.com/shop/twitch.tvraw0nline

## Daily deal refresh

Hand-written deals in `data/deals.json`, including the example cards, stay in the file. The refresh updates two kinds of live deals:

- ASINs you list in `data/asins.json` (these always win)
- Deals it finds on its own from `data/discovery.json`

`data/asins.json` is a JSON array. Each entry needs an `asin`. Optional fields: `promoCode`, `category`, `expires` (`YYYY-MM-DD`), `title`, and `image`. Promo codes are not returned by the Creators API, so put them here when you have one. Leave `category` out and the job fills it from Amazon. A category you type here is kept as you typed it. Do not commit a made-up ASIN. Example shape:

```json
[
  {
    "asin": "B0XXXXXXXX",
    "category": "Home",
    "promoCode": "SAVE10",
    "expires": "2026-11-20",
    "title": "Optional title override",
    "image": "https://example.com/optional-image.jpg"
  }
]
```

Replace `B0XXXXXXXX` with a real ASIN before you commit that entry.

The secrets live in GitHub, not in the repo: **Settings → Secrets and variables → Actions**. The names are `CREATORS_API_CREDENTIAL_ID` and `CREATORS_API_CREDENTIAL_SECRET`. The workflow sends version `3.1` (US token host) and the site tag `onamzeddie0c-20`. Never paste those secrets into a file, an issue, or a workflow.

### Find deals on its own

Open `data/discovery.json`. That file is the only place you need to edit for automatic deals.

| Field | What to put |
| --- | --- |
| `minDiscountPercent` | Smallest discount to keep. `20` means 20% off or more. |
| `minRating` | Star rating. `4` means four stars or better. |
| `maxDeals` | How many discovered deals to keep per day. `20` matches the daily slideshow. The job spreads them across the searches, one from each category before it takes a second from any category. |
| `searches` | One block per search. `keywords` is what you would type into Amazon. `category` is the label on the site. `searchIndex` is Amazon’s department, which keeps the results in that aisle. |

The starting searches are Tech, Home, Pets, Clothing, Fragrances, Drinks, Food, Kitchen, Gaming, Household, Sports, and Toys. Those same names are the labels on the site.

To add a category, copy one block inside `searches` and change the three lines. Example:

```json
{
  "keywords": "board games",
  "searchIndex": "ToysAndGames",
  "category": "Toys"
}
```

You can list up to 16 searches. That cap keeps the morning job to a modest number of Amazon calls: one sign-in, one call per 10 hand-picked ASINs, and one call per search. Twelve searches plus the current ASIN list is about 15 calls. The job waits about a second between those calls, and if Amazon answers “slow down” it tries that call a few more times. It does not page deeper than the first 10 results of each search. If Amazon still refuses, the run stops and `data/deals.json` is left as it was.

Department names you can put in `searchIndex` include `Electronics`, `HomeAndKitchen`, `PetSupplies`, `Fashion`, `Beauty`, `GroceryAndGourmetFood`, `VideoGames`, `HealthPersonalCare`, `SportsAndOutdoors`, and `ToysAndGames`. Leave `searchIndex` out to search all of Amazon. Leave `category` out and the job picks a label from Amazon’s department.

A word you type in `category` is the chip on the site, even if it is new. You do not have to rename anything else for that chip to show up.

If a search name is wrong, the run stops and `data/deals.json` stays as it was. Fix the file and run the workflow again.

### Categories

When an ASIN in `data/asins.json` has no `category`, the job reads Amazon’s product group or browse node and picks one of these labels: Tech, Home, Pets, Clothing, Fragrances, Drinks, Food, Kitchen, Gaming, Household, Sports, Toys. Sports includes outdoor and fitness gear. Household is cleaning, laundry, and paper goods. A category you set on that ASIN wins, and it is not renamed.

Discovered deals use the `category` on their search. That is what keeps a coffee search under Drinks even if Amazon files it next to grocery.

Example cards in the file keep the labels they were given (Electronics, Outdoors, Fitness, and so on). Those are not rewritten, and they are hidden on the site.

### Hide deals that are over

The page and the RSS feed use one filter, `visibleDeals()` in `js/deals.js`. A deal is left off both when:

- `expires` is before today (hand-written deals too)
- an API deal no longer has a discount and has no promo code
- an API deal is out of stock, unavailable, or not yet released
- `verifiedDead` is true (a dead-deal report that the Creators API confirmed)
- `"sample"` is true (example cards)

Those cards are left off the list. The gray “Dead” style is still there for a report that only this browser has made. A verified dead deal is removed from the list for everyone. The job also removes API deals in those states from `data/deals.json` on the next successful run, and it removes a discovered deal that no longer qualifies. Hand-written deals stay in the file, including ones marked `verifiedDead`, but the page and the feed hide them. Example deals are not deleted.

What the job does:

- Reads `data/asins.json` and `data/discovery.json`. If both are empty, it exits successfully and does not touch `data/deals.json`.
- Requests one OAuth token, then calls GetItems in batches of 10 ASINs, then one SearchItems call per discovery search.
- Sets `source` to `"api"`. Discovered deals also get `discovered: true`, so the next run can replace that set. The first day an ASIN appears, `added` is that day in `America/Chicago`. Later runs keep that `added` date and refresh `price`, `originalPrice`, `percentOff`, and `image`.
- If sign-in, GetItems, or SearchItems fails, the script exits with an error and leaves `data/deals.json` unchanged. It does not print the secret or the token.

A local dry run prints the plan and does not call Amazon:

```bash
node scripts/fetch-deals.js
```

`node scripts/fetch-deals.js --live` calls Amazon. Use it only on a machine that has the two credential variables set. Do not put them in the command line.

### Run it from the Actions tab

The workflow is **Daily deal refresh** (`.github/workflows/refresh-deals.yml`). It runs every day at 13:00 UTC, which is 7:00 AM Central Standard Time (8:00 AM during daylight time), when someone starts it by hand, and when `data/asins.json`, `data/discovery.json`, or `data/deals.json` is pushed to `main`. A push that only changes `data/deals.json` rebuilds the feed and does not call Amazon. The morning run still calls Amazon, then rebuilds the feed, so a deal that expired overnight drops out of the email even when prices did not change.

1. Open the [rawdeals](https://github.com/Raw0nline-Deals/rawdeals) repository on GitHub.
2. Click **Actions**.
3. In the left sidebar, click **Daily deal refresh**.
4. Click **Run workflow**.
5. Leave the branch set to `main`, then click **Run workflow** again.
6. Open the run. A green check means the script finished. If `data/deals.json` or `feed.xml` changed, the run adds one commit named `Daily deal refresh` by `github-actions[bot]`. That commit contains only those files.
7. If the Amazon call fails, the run stops before it writes the feed. `data/deals.json` and `feed.xml` on `main` stay as they were.

GitHub does not start a Pages publish from a commit made with the default Actions token. After a bot commit, if the site still shows the old prices, open **Actions**, click **pages-build-deployment**, and re-run the latest run. If the bot cannot push because `main` is protected, allow GitHub Actions to bypass that rule for this repository.

`scripts/fixtures/get-items.sample-from-docs.json` is a fake response shaped like Amazon’s public docs. It is only there so the mapper can be tested. Do not publish it as a deal.

## Daily email feed

Beehiiv can send the same deals the site is showing. The feed is [https://getrawdeals.com/feed.xml](https://getrawdeals.com/feed.xml).

Paste that address into Beehiiv:

1. Open Beehiiv and go to **Settings**, then **RSS**, then **RSS Ingestion**.
2. Click **New External RSS Feed** and paste `https://getrawdeals.com/feed.xml`.
3. In the post type, choose **/rss**. Pick this feed, and turn on **Refresh feed on send**.
4. Go to **Review**, then **Schedule**, then **Schedule recurring series**. Send it every day around **8:00 AM Central**, after the 7:00 AM deal refresh.

The feed is normal RSS. Each item has the product name, the Amazon link with the site tag, the day it was added, the category, the picture, and a short note with the sale price, the original price when there is one, the percent off, and the promo code when there is one. The channel description includes: “As an Amazon Associate I earn from qualifying purchases.”

The list is the same one the page draws. Expired deals, API deals that lost their discount and have no promo code, out-of-stock deals, and example cards are left out. Newest day first.

To rebuild it on your computer after you edit `data/deals.json`:

```bash
node scripts/build-feed.js
```

## Turn on GitHub Pages

Do this **after this pull request is merged into `main`**. The site is plain HTML, CSS, and JavaScript. There is no build step. `.nojekyll` is in the repo so GitHub will not run Jekyll.

1. Open the [rawdeals](https://github.com/Raw0nline-Deals/rawdeals) repository on GitHub.
2. Click **Settings**.
3. In the left sidebar, under **Code, planning, and automation**, click **Pages**.
4. Under **Build and deployment**, if **Source** says **GitHub Actions**, change it to **Deploy from a branch**.
5. Under **Branch**, choose `main` and `/ (root)`.
6. Click **Save**.
7. In **Custom domain**, enter `getrawdeals.com` and click **Save**. The repo already contains a `CNAME` file whose only line is `getrawdeals.com`. Leave that file in place. Saving the domain should keep the same hostname in it.
8. Wait until the Pages settings show that the site was published. The first publish can take a couple of minutes. The Actions tab will show a `pages-build-deployment` run even though the source is a branch. Before the custom domain answers, the site is also at `https://raw0nline-deals.github.io/rawdeals/`.
9. Check **Enforce HTTPS**. If the box is disabled, wait for the certificate (refresh the Pages settings and try again). Leave it checked once it can be checked.

Pages publishes on each push to `main`. The push needs to come from an account that can administer the repo and has a verified email address. If the Pages tab is missing, an owner of the Raw0nline-Deals organization has to allow GitHub Pages for the org’s public repositories.

## DNS already on Cloudflare

Both records should stay **DNS only** (gray cloud, not proxied). Proxying breaks the GitHub certificate check.

| Type | Name | Target |
| --- | --- | --- |
| CNAME | `@` | `raw0nline-deals.github.io` |
| CNAME | `www` | `raw0nline-deals.github.io` |

Cloudflare flattens the apex CNAME. After Pages and HTTPS are on, `https://getrawdeals.com/` is the site and `https://www.getrawdeals.com/` should redirect to it.

## Fonts

Outfit is self-hosted under `fonts/` under the SIL Open Font License (`fonts/outfit-OFL.txt`). Headings use Source Serif 4 from Google Fonts. Fraunces files remain in `fonts/` under `fonts/fraunces-OFL.txt` and are not used by the page.
