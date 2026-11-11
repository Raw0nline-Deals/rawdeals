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
| `expires` | no | `YYYY-MM-DD`. The card shows “Ends …” or “Ended …”. |
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

Under the header, and before the example notice, category filters, and deal list, “How to use a coupon code” explains the three checkout steps.

The top of the page, inside the existing header, has a short headline: “Get Amazon daily deals, hand-picked.”

Below the deals, the newsletter card says “Deals in your inbox.” The Beehiiv signup form is already embedded there. The script is in `index.html`, inside the card. It draws the form in that spot.

The form id is set in one place: the `data-beehiiv-form` attribute on that script. The comment just above it says `BEEHIIV FORM ID`. Change that attribute only if you create a new form in Beehiiv.

If the form script cannot load, or JavaScript is turned off, the card shows a **Subscribe** button instead. The button opens https://raws-newsletter-1cd85b.beehiiv.com/subscribe.

The card still contains an email field, hidden. If that field is shown, **Sign Up** checks the address and opens Beehiiv’s magic link. RawDeals does not store the address. The link is built in `js/signup.js`.

## Affiliate tag

Every Amazon link the page creates goes through `withAffiliateTag()` in `js/affiliate.js`. That function sets `tag=onamzeddie0c-20` on US Amazon hosts (`amazon.com` and short links such as `amzn.to` and `a.co`) and replaces any other tag already on the link. The storefront link uses it too.

Paste a normal product URL in `url`. The tag is added when the page is drawn. The tag string lives in `js/affiliate.js` so it is not copied through the HTML.

The footer on the page includes: “As an Amazon Associate I earn from qualifying purchases.” It also has a short affiliate disclosure. Both are in `index.html`, so they stay visible with the deal list.

Links:

- Linktree: https://linktr.ee/raw0nline
- Amazon storefront: https://www.amazon.com/shop/twitch.tvraw0nline

## Daily deal refresh

Hand-written deals in `data/deals.json`, including the example cards, stay as they are. The refresh only adds and updates deals that come from `data/asins.json`.

`data/asins.json` is a JSON array. It starts empty, which means the daily job does nothing. Each entry needs an `asin`. Optional fields: `promoCode`, `category`, `expires` (`YYYY-MM-DD`), `title`, and `image`. Promo codes are not returned by the Creators API, so put them here when you have one. Do not commit a made-up ASIN. Example shape:

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

What the job does:

- Reads `data/asins.json`. An empty list exits successfully and does not touch `data/deals.json`.
- Requests an OAuth token, then calls GetItems in batches of 10 ASINs.
- Sets `source` to `"api"`. The first day an ASIN appears, `added` is that day in `America/Chicago`. Later runs keep that `added` date and refresh `price`, `originalPrice`, `percentOff`, and `image`.
- Drops an API deal when the offer is missing, the listing violates MAP, or `expires` is before today. Example deals are not dropped.
- If sign-in or GetItems fails, the script exits with an error and leaves `data/deals.json` unchanged. It does not print the secret or the token.

A local dry run prints the plan and does not call Amazon:

```bash
node scripts/fetch-deals.js
```

`node scripts/fetch-deals.js --live` calls Amazon. Use it only on a machine that has the two credential variables set. Do not put them in the command line.

### Run it from the Actions tab

The workflow is **Daily deal refresh** (`.github/workflows/refresh-deals.yml`). It runs every day at 13:00 UTC, which is 7:00 AM Central Standard Time (8:00 AM during daylight time), and when someone starts it by hand.

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
