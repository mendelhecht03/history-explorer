# History Explorer

A private, multi-user web app for your Safari history. It shows stats, lists of links you can copy, every search you made, and a "habit check" that suggests addictive sites to block. It works best on iPhone and can be added to your home screen.

## How history gets in

| Source | What it does | Cost |
|---|---|---|
| **Live sync**: a script running in the free [Userscripts](https://apps.apple.com/app/id1463298887) Safari extension | Sends each page's link, title and time as you browse. Visits wait on the phone when offline and are sent later. | Free |
| **Safari export**: Settings › Apps › Safari › Export (iOS 18.2+) | Brings in all past history and fills gaps. Upload it on the Settings page. Uploading again is safe because duplicates are merged. | Free |

Merging rules: a page reloaded within 30 s counts once. A live visit within 2 minutes of the same page in an export is treated as the same visit, and the export's copy is kept. Private Browsing visits only come from live sync.

## Privacy

- Each account is isolated. Every row carries `user_id`, and every query filters by it.
- Only the URL (with fragments, credentials and tracking parameters such as `utm_*` and `fbclid` removed), the page title, and the visit time are stored. Uploaded files are parsed in memory and never saved.
- Sign-in uses passkeys only, so there are no passwords or emails, plus a one-time recovery code. Devices use per-device upload keys that can only add history. They can't read anything, and they can be revoked from Settings.
- Users can delete all their history or their whole account from Settings. There's no analytics and no third-party requests.

## Stack

Cloudflare Workers + D1 (SQLite) + static assets. `src/` holds the API, and `public/app.html` is the dashboard ported from the original local Chrome-history version. The server fills in each user's data when serving the page.

## Develop

```sh
npm install
npx wrangler d1 migrations apply history-explorer --local
npx wrangler dev            # http://localhost:8787
npx tsc -p .                # type-check
```

Passkeys need `localhost` or HTTPS. To test on a phone, deploy to a preview.

## Deploy (not done yet)

1. `npx wrangler login`, then `npx wrangler d1 create history-explorer` and put the id in `wrangler.toml`.
2. Set `ORIGIN` and `RP_ID` in `wrangler.toml` to the real domain.
3. `npx wrangler d1 migrations apply history-explorer --remote`, then `npx wrangler deploy`.

Large first imports (tens of thousands of visits) need more CPU time than the Workers free plan allows, so plan on Workers Paid ($5/month).
