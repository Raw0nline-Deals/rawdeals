# Promo codes

Codes you type yourself live in `data/codes.json`. That file is only for codes you control: brand-provided creator codes, codes from WhatsApp brand deals, and Amazon Creator Connections.

The daily refresh does not read or write `data/codes.json`. It updates `data/deals.json` and `feed.xml` only. A deal card can still have its own `promoCode` in the deal list. This file is a separate section on the homepage.

The file is public. `notes` is shown on the page. Do not put private messages in it.

Ship real codes only. Do not invent one.

## Add a code

Open `data/codes.json`. It is a JSON array. Paste one object per code. Keep the commas valid: a comma between objects, and no comma after the last one.

```json
{
  "id": "brand-name-2026-12",
  "brand": "Brand Name",
  "title": "Short description of the offer",
  "code": "CODEHERE",
  "url": "https://www.amazon.com/dp/ASIN",
  "discount": "10% off entire order",
  "starts": "2026-11-17",
  "expires": "2026-12-31",
  "notes": "1 per customer"
}
```

Replace every placeholder before you commit. `CODEHERE` is not a real code.

| Field | Required | What to put |
| --- | --- | --- |
| `id` | yes | A unique id. A brand plus a date works. |
| `brand` | yes | The brand name, shown above the title. |
| `title` | one of these | Short label for the offer. You can use `description` instead of `title`. If you set both, `title` is the heading and `description` is the line under it. |
| `description` | one of these | Same job as `title` when you do not set `title`. |
| `code` | yes | The code a shopper pastes at checkout. |
| `url` | no | Product or store link. Leave the field out when there is nowhere to send them. |
| `discount` | yes | Free text, such as `10% off entire order`. |
| `starts` | no | `YYYY-MM-DD`. The first day the code may show. Leave it out to show the code immediately. |
| `expires` | yes | `YYYY-MM-DD`. Last day the code may show. |
| `notes` | no | Extra limits, such as `1 per customer`. Shown on the card. |

Paste a normal `https://` link in `url`. For an Amazon link, do not add a different Associates tag. The page sets `tag=eddie060-20` on US Amazon links (`amazon.com`, `a.co`, `amzn.to`). A link that already uses `eddie060-20` is left as written. A non-Amazon link is left as written.

The page hides the whole Promo Codes section, and the **Promo codes** link in the header, when nothing is active. After you commit and the site publishes, reload. An active code appears above the deal search.

`data/codes.json` already contains one object, `example-expired`. Its title says EXAMPLE, its code is `EXAMPLE`, and it expired on 2020-01-01, so the page does not show it. Delete that object when you add a real code, or leave it. It stays hidden.

## Remove a code

Delete that object from the array. Fix the commas so the file is still a JSON array. Commit and push, or merge a pull request.

To keep a record without showing the code, set `expires` to a date before today in America/Chicago. The page hides it. The object stays in the file until you delete it.

The daily refresh does not prune this file. A code that expired more than 30 days ago is still ignored by the page, and it stays in the file. Delete those objects yourself when you want the file shorter.

## How expiry works

Dates are calendar days in America/Chicago, the same clock the rest of the site uses. There is no time of day on the code.

`expires` is inclusive through the end of that day. If today in Chicago is 2026-11-17:

- `expires` of `2026-11-17` still shows
- `expires` of `2026-11-16` is hidden
- `starts` of `2026-11-18` stays hidden until that date
- `starts` of `2026-11-17` shows
- no `starts` field shows as soon as it has not expired

The next Chicago date after `expires` is the first day the code is hidden. A code with a future `starts` date stays hidden until that date.

An entry with a bad date, a missing code, or a `starts` date after `expires` is skipped.

## Later: affiliate coupon feeds

This file is hand-edited. Nothing imports coupons into it yet.

If you are approved with advertisers on Impact.com, those coupon feeds could later be imported automatically into this same file format (`id`, `brand`, `title`, `code`, `url`, `discount`, `expires`, and optional `starts` and `notes`). That importer does not exist yet. Until it does, paste Impact codes here the same way as a WhatsApp code or a Creator Connections code.
