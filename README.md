# RawDeals

Daily Amazon deals from [Raw0nline](https://linktr.ee/raw0nline) (Eddie). The site is static and is meant to be hosted free on GitHub Pages at [getrawdeals.com](https://getrawdeals.com/).

The deals on the page right now are **examples**. Names, prices, and promo codes are made up so the layout has something to show. Cards are marked **Example**. Delete them before you announce the site.

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

Remove every deal with `"sample": true` before you share the site. While any remain, a notice at the top says the prices are not live.

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

You can list up to 16 searches. That cap keeps the morning job to a modest number of Amazon calls: one sign-in, one call per 10 hand-picked ASINs, and one call per search. Twelve searches plus the current ASIN list is about 15 calls. The job does not page deeper than the first 10 results of each search.

Department names you can put in `searchIndex` include `Electronics`, `HomeAndKitchen`, `PetSupplies`, `Fashion`, `Beauty`, `GroceryAndGourmetFood`, `VideoGames`, `HealthPersonalCare`, `SportsAndOutdoors`, and `ToysAndGames`. Leave `searchIndex` out to search all of Amazon. Leave `category` out and the job picks a label from Amazon’s department.

A word you type in `category` is the chip on the site, even if it is new. You do not have to rename anything else for that chip to show up.

If a search name is wrong, the run stops and `data/deals.json` stays as it was. Fix the file and run the workflow again.

### Categories

When an ASIN in `data/asins.json` has no `category`, the job reads Amazon’s product group or browse node and picks one of these labels: Tech, Home, Pets, Clothing, Fragrances, Drinks, Food, Kitchen, Gaming, Household, Sports, Toys. Sports includes outdoor and fitness gear. Household is cleaning, laundry, and paper goods. A category you set on that ASIN wins, and it is not renamed.

Discovered deals use the `category` on their search. That is what keeps a coffee search under Drinks even if Amazon files it next to grocery.

Example cards already on the page keep the labels they were given (Electronics, Outdoors, Fitness, and so on). Those are not rewritten.

### Hide deals that are over

The page does not show a deal as active when:

- `expires` is before today (hand-written deals too)
- an API deal no longer has a discount and has no promo code
- an API deal is out of stock, unavailable, or not yet released

Those cards are left off the list. The gray “Dead” style is still there for a deal you report by hand in the browser. The job also removes API deals in those states from `data/deals.json` on the next successful run, and it removes a discovered deal that no longer qualifies. Hand-written deals stay in the file. Example deals are not deleted.

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

The workflow is **Daily deal refresh** (`.github/workflows/refresh-deals.yml`). It runs every day at 13:00 UTC, which is 7:00 AM Central Standard Time (8:00 AM during daylight time), when someone starts it by hand, and when `data/asins.json` or `data/discovery.json` is pushed to `main`.

1. Open the [rawdeals](https://github.com/Raw0nline-Deals/rawdeals) repository on GitHub.
2. Click **Actions**.
3. In the left sidebar, click **Daily deal refresh**.
4. Click **Run workflow**.
5. Leave the branch set to `main`, then click **Run workflow** again.
6. Open the run. A green check means the script finished. If `data/deals.json` changed, the run adds a commit named `Daily deal refresh` by `github-actions[bot]`, and that commit contains only `data/deals.json`.
7. If the run fails, `data/deals.json` on `main` is still the previous file.

GitHub does not start a Pages publish from a commit made with the default Actions token. After a bot commit, if the site still shows the old prices, open **Actions**, click **pages-build-deployment**, and re-run the latest run. If the bot cannot push because `main` is protected, allow GitHub Actions to bypass that rule for this repository.

`scripts/fixtures/get-items.sample-from-docs.json` is a fake response shaped like Amazon’s public docs. It is only there so the mapper can be tested. Do not publish it as a deal.

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
