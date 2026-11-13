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

Put new deals anywhere in the array. The page groups by `added` and shows the newest day first. Today stays open. Each earlier day is a collapsed section: the header shows the date and how many deals are in it, and clicking it opens that day. Within a day, cards stay in the order they appear in the file, with men's and women's clothing sorted ahead of other clothing.

Commit the file and push to `main` (or merge a pull request). GitHub Pages publishes the update. Browsers are asked to revalidate `deals.json`. A refresh a minute or two later should show the new day.

Run `node scripts/validate-deals.js` before you push if you want the file checked.

Deals with `"sample": true` stay in the file. The page and the RSS feed both hide them, so they are not shown as live deals. Delete those objects when you no longer want them in the file.

## Promo codes and the Copy button

The Copy button writes the code to the clipboard and the button label changes to **Copied**. That happens in the visitor’s browser.

## Report dead deal

**Report dead deal** grays that card out and adds a **Dead** label. **Undo report** clears it.

Reports are stored only in that browser, under the localStorage key `rawdeals.deadReports.v1`. Nothing is sent to you. The value is a JSON array of:

```json
{ "id": "deal-id", "reportedAt": "2026-11-09T12:00:00.000Z", "source": "local" }
```

`js/dead-deals.js` is the only place that reads and writes those reports. The page calls `list()`, `report()`, and `retract()`. A later shared backend can replace those three methods and keep the same record shape, with `source` set to `"api"`. The comments in that file name the routes that would fit: `GET /api/dead-deals`, `POST /api/dead-deals`, and `DELETE /api/dead-deals/:id`.

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

Hand-written deals in `data/deals.json`, including example cards, stay in the file while their `added` date is inside the last 7 days (today included). The refresh updates two kinds of live deals:

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

### AmazonOfferCode promo codes

The same **Daily deal refresh** job can also read promo codes from [AmazonOfferCode](https://amazonoffercode.com/api). It runs only after the Creators API refresh has succeeded. If `AMAZONOFFERCODE_API_KEY` is missing, that part logs a skip and the Creators deals are still saved. A bad key, a disabled key, a monthly limit, or a failed request does the same: it stops the promo calls and leaves the Creators result in place.

The refresh step is the only step that receives `AMAZONOFFERCODE_API_KEY`, from the repository secret of that name. The script never prints the key. A failed request log replaces the key, and any `token=` query value, with `[redacted]`.

Setup for the free key:

1. Open [amazonoffercode.com/api](https://amazonoffercode.com/api) and create the free key. The free plan is 100 requests a month. No credit card.
2. In the [rawdeals](https://github.com/Raw0nline-Deals/rawdeals) repo, open **Settings → Secrets and variables → Actions → New repository secret**.
3. Name it `AMAZONOFFERCODE_API_KEY` and paste the key. Do not put the key in a file, the workflow, or a pull request. This secret is already set on the repository.
4. The next 13:00 UTC run, or **Run workflow**, picks it up. Do not merge this change until it has been reviewed. Merging is what lets the scheduled job start calling the promo API.

`data/amazonoffercode.json` is the category list. The default slugs are `electronics`, `home`, and `kitchen` (the API’s own examples also include `sports` and `beauty`). Each run calls at most 3 categories, `limit=100`, `active=true`, `marketplace=us`, and does not ask for page 2 even when `has_more` is true. The log prints `meta.usage` after each call.

Call budget: 3 calls × 1 scheduled run a day × 30 days is about 90, under the free plan’s 100. A manual **Run workflow**, or a push of `data/asins.json` or `data/discovery.json`, is another live run and spends up to 3 more. About 10 requests are left for those. A `429` stops the rest of the promo calls for that run.

A row with a `coupon_code` is stored as `promoCode`, so the card keeps the Copy button. A row with `coupon_code: null` is auto-applied: the card’s link reads “discount applied at checkout” and there is no Copy button. `end_date` is saved as `expires`, and the card shows it the same way as other end dates. Rows that are not `is_active`, or whose `end_date` is already past, are left out. Baby and infant titles are left out too.

Deals are matched by ASIN. When the Creators API already has that ASIN, its price, title, and image stay, and the code or the checkout link is added. A code already typed in `data/asins.json` is kept. A Creators result that is out of stock, unsellable, or already ended is not brought back by a promo row. The paged keyword search runs first and stops at `maxDeals` new discoveries. Promo-only deals are added after that, and only into slots that search left open. They use the same 7-day window and the same RSS rule: today is in the feed, earlier days stay on the page and stay collapsed.

`useOwnTag` defaults to true. Coded deals link to `https://www.amazon.com/dp/<ASIN>?tag=onamzeddie0c-20`. Auto-applied deals keep the `amazon_link` promo page, with its `tag` replaced or added as `onamzeddie0c-20`. Set `useOwnTag` to false in `data/amazonoffercode.json`, or set the Actions variable `AOC_USE_OWN_TAG` to `false`, to leave `amazon_link` as AmazonOfferCode sent it. The page normally rewrites every Amazon link to the site tag. When the flag is false, those promo deals set `preserveAffiliateTag` so the stored tag is left alone.

AmazonOfferCode publishes no terms of service. Their docs say your own Associates ID is written onto `amazon_link` only on a paid plan. On the free plan that link carries their tag. Rewriting it is what `useOwnTag` does, and it is on by default so RawDeals links use `onamzeddie0c-20`.

Check the built links, and optionally follow one public promo URL, with no API key:

```bash
node scripts/check-promo-tag.js
node scripts/check-promo-tag.js --live
```

### Find deals on its own

Open `data/discovery.json`. That file is the only place you need to edit for automatic deals.

| Field | What to put |
| --- | --- |
| `minDiscountPercent` | Smallest discount to keep. `20` means 20% off or more. |
| `minRating` | Star rating. `4` means four stars or better. |
| `maxDeals` | How many new discovered deals to add on a run. `20` matches the daily slideshow. Deals already saved from earlier days do not use these slots. The job spreads the new ones across the searches it actually ran, one from each category before it takes a second from any category. |
| `pagesPerKeyword` | How many result pages to read for each keyword chosen that morning. Amazon allows `itemPage` 1 through 10 and `itemCount` 1 through 10, so this is a whole number from 1 to 10. The job asks for 10 products a page. `3` reads up to 30 products per keyword. |
| `keywordsPerRun` | How many entries to take from the `searches` pool each morning. `12` is one keyword from each favored category. The date picks which keyword, and which category is searched first. |
| `maxRequests` | Most catalog calls (GetItems batches plus SearchItems pages) in one run. `48` covers the current ASIN list plus every selected keyword at `pagesPerKeyword` 3. The job stops sooner when it already has `maxDeals` new discoveries. |
| `searches` | The keyword pool. Not every row runs every morning. `keywords` is what you would type into Amazon. `category` is the label on the site. `searchIndex` is Amazon’s department, which keeps the results in that aisle. |

The starting searches cover Tech, Gaming, Kitchen, Home, Pets, Fragrances, Drinks, Household, Toys, Sports, Food, and Clothing. The filter chips use that order. General and any other label come after those.

`priority` is a short extra list for products to look for on purpose: permanent outdoor house lights (Home), gaming microphones, and gaming headsets (both Gaming). A match still has to be at least `minDiscountPercent` off, about `minRating` stars, and in stock. Those deals are marked `"priority": true` and the run prints `Priority watch:` with their ids. Men's and women's clothes, including hoodies, shirts, shorts, and dresses, are picked and shown ahead of other clothing. Baby and infant items, such as onesies, rompers, bibs, and anything for a newborn, infant, or toddler, are left off the site. A color name such as Baby Blue is not treated as a baby product.

To add a category, copy one block inside `searches` and change the three lines. Example:

```json
{
  "keywords": "board games",
  "searchIndex": "ToysAndGames",
  "category": "Toys"
}
```

`searches` can list up to 96 keywords. A single morning still searches at most 16 keywords, counting `keywordsPerRun` and `priority` together. The shipped pool has several keywords in each of the twelve categories. The lists are different lengths so the categories do not all come back to the same keyword on the same morning. The job keeps every `priority` search, then takes `keywordsPerRun` more, rotating by the Chicago date so the next morning searches a different product type. The category at the front of that list also changes with the date, because the run stops once it has enough new deals.

Each chosen keyword starts at page 1. The next page is requested only while the run still needs discoveries, the request budget has room, and the page just read contained an ASIN that is not already in `data/deals.json` or `data/asins.json`. Amazon’s SearchItems operation returns at most 10 items per page (`itemCount` 1 through 10) and at most 10 pages (`itemPage` 1 through 10). When the response includes `totalResultCount` and this page already covers it, that keyword stops. A saved discovery that shows up again is refreshed. It does not take one of the `maxDeals` slots.

The morning run is one sign-in, then catalog calls. Sign-in is not a Creators API transaction. Catalog calls are one GetItems request per 10 hand-picked ASINs, then one SearchItems request per page. The current ASIN list is 11 products, so that is 2 GetItems calls. The daily selection is 3 priority searches plus 12 keywords. At 3 pages each, that is 45 SearchItems calls. 2 + 45 = 47, which fits under `maxRequests` of 48. The run usually stops earlier: it quits paging once it has 20 new qualifying discoveries, so a typical morning is those 2 GetItems calls plus the SearchItems pages needed to reach 20, not all 45. The expected addition is 20 new deals, which is the slideshow cap. It can be fewer when the rotated keywords run out of new ASINs first.

A new Creators API credential is limited to 1 request per second and 8,640 requests per day. The job waits about a second between catalog calls, which stays under that 1-per-second limit. One morning’s 48 calls is a small slice of the daily 8,640. If Amazon answers “slow down” (HTTP 429), the job waits and tries that call again, up to three more times. The wait doubles each time (2 seconds, then 4, then 8). If the error body includes `retryAfterSeconds`, the job waits at least that long, and never more than 120 seconds for one wait. If Amazon still refuses, the run stops and `data/deals.json` is left as it was.

Department names you can put in `searchIndex` include `Electronics`, `HomeAndKitchen`, `PetSupplies`, `Fashion`, `Beauty`, `GroceryAndGourmetFood`, `VideoGames`, `HealthPersonalCare`, `SportsAndOutdoors`, and `ToysAndGames`. Leave `searchIndex` out to search all of Amazon. Leave `category` out and the job picks a label from Amazon’s department.

A word you type in `category` is the chip on the site, even if it is new. You do not have to rename anything else for that chip to show up.

If a search name is wrong, the run stops and `data/deals.json` stays as it was. Fix the file and run the workflow again.

### Categories

When an ASIN in `data/asins.json` has no `category`, the job reads Amazon’s product group or browse node and picks one of these labels: Tech, Home, Pets, Clothing, Fragrances, Drinks, Food, Kitchen, Gaming, Household, Sports, Toys. Sports includes outdoor and fitness gear. Household is cleaning, laundry, and paper goods. A category you set on that ASIN wins, and it is not renamed.

Discovered deals use the `category` on their search. That is what keeps a coffee search under Drinks even if Amazon files it next to grocery.

Example cards in the file keep the labels they were given (Electronics, Outdoors, Fitness, and so on). Those are not rewritten, and they are hidden on the site.

### Hide deals that are over

The page uses `visibleDeals()` in `js/deals.js`. A deal is left off the page when:

- `expires` is before today (hand-written deals too, and an AmazonOfferCode `end_date` stored as `expires`)
- an API deal no longer has a discount, has no promo code, and is not an auto-applied checkout discount
- an API deal is out of stock, unavailable, or not yet released
- `verifiedDead` is true
- `"sample"` is true (example cards)
- `added` is outside the 7-day window (`DEAL_RETENTION_DAYS` in `js/deals.js`: today and the 6 days before it)

Those cards are left off the list. The gray “Dead” style is still there for a deal you report by hand in the browser. The job also removes API deals in the dead, out-of-stock, or ended states from `data/deals.json` on the next successful run. A discovered deal that misses the day’s `maxDeals` cut stays, with the `added` date from the first day it was seen, until that date is older than 7 days or Amazon shows it no longer qualifies. Hand-written deals inside the window stay in the file, including expired ones and example cards. The refresh deletes deals, including hand-written ones, whose `added` date is older than 7 days.

A deal the run confirms again today (it is still in `data/asins.json`, or it still qualifies in a search) whose first-seen date is already outside the window is saved again with `added` set to today. That keeps a still-live ASIN on the page instead of dropping it for a day.

What the job does:

- Reads `data/asins.json` and `data/discovery.json`. If both are empty, it exits successfully and does not touch `data/deals.json`.
- Requests one OAuth token, then calls GetItems in batches of 10 ASINs. Hand-picked batches always run. It then calls SearchItems for the day’s keywords, page by page, and stops at `maxDeals` new discoveries, a page with no new ASINs, or `maxRequests` catalog calls. AmazonOfferCode runs after that search. A matching ASIN gains its code or checkout link. New promo-only deals fill only the `maxDeals` slots the paged search did not use.
- Sets `source` to `"api"`. Discovered deals also get `discovered: true`. The first day an ASIN appears, `added` is that day in `America/Chicago`. Later runs keep that `added` date and refresh `price`, `originalPrice`, `percentOff`, and `image`, including for a discovery that is not one of the new `maxDeals` picks.
- Prints a `Dropped ASIN (reason).` line for each ASIN it removes. It prints `Hand-written deals were kept.` only when the file still has a hand-written deal.
- If sign-in, GetItems, or SearchItems fails, the script exits with an error and leaves `data/deals.json` unchanged. It does not print the secret or the token. The AmazonOfferCode call runs only after that refresh succeeds. If the promo key is missing or the promo call fails, the script still saves the Creators deals and does not print the key.

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

The feed is normal RSS. Each item has the product name, the Amazon link with the site tag, the day it was added, the category, the picture, and a short note with the sale price, the original price when there is one, the percent off, the promo code when there is one, “Discount applied at checkout” when the discount is automatic, and the end date when there is one. The channel description includes: “As an Amazon Associate I earn from qualifying purchases.”

The feed lists deals added today only, so the earlier days on the page are not sent again as new email items. Expired deals, API deals that lost their discount and have no promo code or checkout discount, out-of-stock deals, verified-dead deals, deals older than 7 days, and example cards are left out. Newest of today’s deals first. The page still shows the rest of the 7-day window, with today open and each earlier day collapsed.

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
