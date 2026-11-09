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

The panel under the deal list is a working signup form. **Sign Up** checks the address, then opens Beehiiv’s magic link with the email encoded in the query string. RawDeals does not store the address. The link is built in `js/signup.js`.

## Affiliate tag

Every Amazon link the page creates goes through `withAffiliateTag()` in `js/affiliate.js`. That function sets `tag=onamzeddie0c-20` on US Amazon hosts (`amazon.com` and short links such as `amzn.to` and `a.co`) and replaces any other tag already on the link. The storefront link uses it too.

Paste a normal product URL in `url`. The tag is added when the page is drawn. The tag string lives in `js/affiliate.js` so it is not copied through the HTML.

The footer on the page includes: “As an Amazon Associate I earn from qualifying purchases.” It also has a short affiliate disclosure. Both are in `index.html`, so they stay visible with the deal list.

Links:

- Linktree: https://linktr.ee/raw0nline
- Amazon storefront: https://www.amazon.com/shop/twitch.tvraw0nline

## Amazon Creators API (not connected)

Credentials are **not** in this repo and must never be committed, including in `.env` files. `.gitignore` ignores `.env`.

`scripts/fetch-deals.js` is a stub. It does not call Amazon. `node scripts/fetch-deals.js` prints the request it would make for the placeholder ASINs in `data/watchlist.json`. `node scripts/fetch-deals.js --live` exits with an error and still sends nothing.

A future daily job would:

1. In the GitHub repo, open **Settings → Secrets and variables → Actions** and add:
   - `CREATORS_API_CREDENTIAL_ID`
   - `CREATORS_API_CREDENTIAL_SECRET`
   - `CREATORS_API_CREDENTIAL_VERSION` (`3.1` for the North America token host)
2. Keep those values only in secrets. Do not put them in the workflow file.
3. Request a token with `grant_type=client_credentials` and `scope=creatorsapi::default`. Version `3.1` uses `https://api.amazon.com/auth/o2/token`, `3.2` uses `https://api.amazon.co.uk/auth/o2/token`, and `3.3` uses `https://api.amazon.co.jp/auth/o2/token`.
4. `POST https://creatorsapi.amazon/catalog/v1/getItems` with header `x-marketplace: www.amazon.com` and the body `buildGetItemsBody()` already builds. `partnerTag` should stay `onamzeddie0c-20`.
5. Map each item with `mapCreatorsItemToDeal()`:
   - price ← `offersV2.listings[].price.money.amount` (prefer `isBuyBoxWinner`)
   - original price ← `price.savingBasis.money.amount`
   - percent off ← `price.savings.percentage`
   - expiry ← the date from `dealDetails.endTime`
   - url ← `detailPageURL`
   - image ← `images.primary.large.url`
   - title ← `itemInfo.title.displayValue`
   - Skip a listing when `violatesMAP` is true or the price is missing.
6. Promo codes are **not** in OffersV2. Keep them on each ASIN in `data/watchlist.json`. The mapper copies `promoCode` from that extra data.
7. Merge with `mergeDeals()` and commit the new `data/deals.json`. Set `sample` to `false` and `added` to that day’s date in `America/Chicago`.

Do not add a workflow that passes `--live` until the stub is intentionally changed to perform those calls. The categories you care about still come from the watchlist, not from the API.

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
