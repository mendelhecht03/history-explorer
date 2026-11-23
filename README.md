# History Explorer

A private, multi-user web app for your Safari history. It shows stats, lists of links you can copy, every search you made, and a "habit check" that suggests addictive sites to block. It works best on iPhone and can be added to your home screen.

## How history gets in

| Source | What it does | Cost |
|---|---|---|
| **Live sync**: a script running in the free [Userscripts](https://apps.apple.com/app/id1463298887) Safari extension | Sends each page's link, title and time as you browse. Visits wait on the phone when offline and are sent later. | Free |
| **Safari export**: Settings › Apps › Safari › Export (iOS 18.2+) | Brings in all past history and fills gaps. Upload it on the Settings page. The browser reads the file and sends only link, title and time, in batches. Uploading again is safe because duplicates are merged. | Free |

Merging rules: a page reloaded within 30 s counts once. A live visit within 2 minutes of the same page in an export is treated as the same visit, and the export's copy is kept. Private Browsing visits only come from live sync.

## Privacy

- Each account is isolated. Every row carries `user_id`, and every query filters by it.
- Only the URL (with fragments, credentials and tracking parameters such as `utm_*` and `fbclid` removed), the page title, and the visit time are stored. Export files are read in the browser and never uploaded whole.
- Sign-in uses passkeys only, so there are no passwords or emails, plus a one-time recovery code. Devices use per-device upload keys that can only add history. They can't read anything, and they can be revoked from Settings.
- Users can delete all their history or their whole account from Settings. There's no analytics and no third-party requests.
- The dashboard keeps a copy of your history in the browser (IndexedDB) so it opens fast and only downloads new visits. Signing out or deleting history clears that copy.

## Stack

Cloudflare Workers + D1 (SQLite) + static assets, sized for the **free plan**. Each request does a small, bounded amount of work, under the 10 ms CPU and 50-query limits. Heavy work runs in the browser: unzipping exports, detecting searches, and computing stats. `src/` holds the API. `public/app.html` is the dashboard ported from the original local Chrome-history version. `public/data.js` syncs and caches history for it.

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

Free-plan limits to know about: D1 allows 100,000 row writes per day across all users. A very large first import can hit that limit. When it does, the upload stops and tells you to upload the same file again later, and it picks up where it left off.
