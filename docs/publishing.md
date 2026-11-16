# Publishing the extension

Zero Notes ships to the Chrome Web Store, Microsoft Edge Add-ons and Firefox Add-ons. Edge uses the Chrome zip unchanged. The Firefox zip gets a patched manifest (event-page background and a Gecko ID).

## How releases work

1. Bump `version` in `chrome-extension/manifest.json` and merge to `main`.
2. Tag and push: `git tag v1.0.1 && git push origin v1.0.1`.
3. `.github/workflows/release.yml` builds both zips, attaches them to a GitHub release and submits them to every store that is configured. A store is skipped until its ID variable is set.

Build the zips locally with `./scripts/package-extension.sh`. They land in `dist/`.

## One-time setup

Each store needs its first version uploaded by hand. After that, CI handles updates. Add variables and secrets under **Settings → Secrets and variables → Actions**.

### Before you submit anywhere

- Pick one name. The manifest says "Local Text Notes", the README and CLI say "Zero Notes".
- Write a privacy policy page. Saying that notes never leave the browser is enough, but the stores want a URL.
- Take screenshots at 1280×800. Chrome also wants a 440×280 promo tile.
- Be ready to justify `scripting`, the optional host permissions and `nativeMessaging`. Reviewers ask about broad host access.

### Chrome Web Store

1. Register at the [developer dashboard](https://chrome.google.com/webstore/devconsole) (one-time $5 fee) and upload `zero-notes-chrome-*.zip` by hand.
2. In Google Cloud, create a project, enable the **Chrome Web Store API**, create a service account and download a JSON key for it.
3. In the dashboard's account settings, add the service account's email.
4. Set variables `CHROME_EXTENSION_ID` and `CHROME_PUBLISHER_ID` (both shown in the dashboard). Set secrets `CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL` and `CHROME_SERVICE_ACCOUNT_PRIVATE_KEY` (`client_email` and `private_key` from the JSON key).

### Microsoft Edge Add-ons

1. Register in [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge) (free) and upload the Chrome zip by hand.
2. Under **Publish API**, create API credentials.
3. Set the variable `EDGE_PRODUCT_ID` and the secrets `EDGE_CLIENT_ID` and `EDGE_API_KEY`.

### Firefox Add-ons

1. Sign in at [addons.mozilla.org](https://addons.mozilla.org/developers/) and upload `zero-notes-firefox-*.zip` by hand.
2. Create API keys at [API credentials](https://addons.mozilla.org/developers/addon/api/key/).
3. Set the variable `FIREFOX_EXTENSION_ID` to the Gecko ID, `zero-notes@madsolame.com`. Set the secrets `FIREFOX_JWT_ISSUER` and `FIREFOX_JWT_SECRET`.

The Gecko ID is set in `scripts/package-extension.sh`. It is permanent once the add-on exists on AMO, so change it before the first upload if you want another one.

### Optional: approval before publishing

Create a GitHub environment with required reviewers and add `environment: <name>` to the store jobs. Then move the secrets into that environment.

## Things to know

- The CLI only works with Google Chrome. The store version gets a new extension ID, so users pass that ID to `zero-notes install`. Edge and Firefox users can't connect the CLI yet.
- Store review takes from a few hours to several days. A green CI run means the version was submitted, not that it is live.
- Safari needs an Xcode wrapper (`xcrun safari-web-extension-converter`) and an Apple Developer account. It isn't covered here.
