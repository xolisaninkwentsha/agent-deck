# Modisa relay

The relay lets Modisa send approvals and questions to your phone over WhatsApp, and passes your answers back. It is a Cloudflare Worker with one Durable Object:

- each Modisa daemon keeps one outgoing WebSocket to `wss://<worker host>/link`;
- WhatsApp (Meta's Cloud API) calls `https://<worker host>/whatsapp/webhook` when you message the bot or tap a button;
- `https://<worker host>/health` answers `ok`.

This guide is for running your own relay: your own Cloudflare account, your own Meta app and number, and billing off. Modisa has no relay address set until you enter one in Settings, and it only connects to a relay while you're linking a number or a number is linked.

## What you need

- Node.js 22.12.0 or later (the pinned Wrangler, 4.168.0, needs it).
- A Cloudflare account. The Workers Free plan includes SQLite-backed Durable Objects, which is all the relay uses.
- A Meta developer account, and a phone with WhatsApp to approve from.

## 1. Deploy the Worker

From this folder (`relay/`):

```sh
npm i
npx wrangler login      # once, opens a browser
npx wrangler deploy
```

`deploy` prints the Worker's address, for example `https://modisa-relay.<your-subdomain>.workers.dev`. That host is the `<worker host>` used below. Check it:

```sh
curl https://<worker host>/health    # ok
```

The relay has no settings in `wrangler.toml`. Everything is set as a Worker secret, one at a time:

```sh
npx wrangler secret put WA_TOKEN
```

Wrangler asks for the value. You can also pipe it in: `printf %s "$VALUE" | npx wrangler secret put WA_TOKEN`. Leading and trailing spaces and newlines are ignored.

Required (the webhook and `/link` answer "relay is not configured" until all six are set):

| Name | What it is |
| --- | --- |
| `WA_TOKEN` | A Meta access token that can send WhatsApp messages (see step 2). |
| `WA_PHONE_NUMBER_ID` | The bot number's Phone number ID, from WhatsApp → API Setup. This is an id, not the phone number. Webhook calls for any other number on the same Meta app are ignored. |
| `WA_APP_SECRET` | Your Meta app's App secret (App settings → Basic). The relay uses it to check that webhook calls really come from Meta. |
| `WA_VERIFY_TOKEN` | Any long random string you make up, for example the output of `openssl rand -hex 32`. You give the same string to Meta in step 3. |
| `BOT_NUMBER` | The bot's WhatsApp number with its country code, for example `+1 555 010 0000`. Modisa shows it and builds the `wa.me` link from it. |
| `GRAPH_VERSION` | The Graph API version to call, as shown in API Setup's sample request (it looks like `v23.0`). |

Optional (leave these unset on your own relay):

| Name | Default | What it does |
| --- | --- | --- |
| `BILLING` | `off` | `off`, `trial` or `on`. See "Billing" below. |
| `HOURLY_CAP` | `60` | The most messages the bot sends to one number in any hour. It applies even with billing off, so a runaway session can't flood your phone. |
| `TEMPLATE_NAME` | `modisa_needs_you` | The message template used outside WhatsApp's 24-hour window (step 4). |
| `TEMPLATE_LANG` | `en` | That template's language code. |
| `TRIAL_MICRO_USD` | `0` | Only with billing on: the starting credit for a new number, in millionths of a US dollar. |
| `RATES_JSON` | `{"default":0}` | Only with billing on: the cost of one message in micro-USD, by country-code prefix, for example `{"default":10000,"44":9000}`. The longest matching prefix wins. With `BILLING` set to `trial` or `on`, `default` must be above 0. |
| `MARKUP_PERCENT` | `0` | Only with billing on: added on top of `RATES_JSON`. |

A bad value (an unknown `BILLING`, a negative number, `RATES_JSON` without a `default`, or a `default` of 0 with billing `trial` or `on`) stops the webhook and `/link` with an error that names the variable. `npx wrangler tail` shows it.

## 2. Create the Meta app and number

1. At [developers.facebook.com](https://developers.facebook.com), create an app and add the **WhatsApp** product to it. Meta sets up a business account and a free **test number** for you.
2. Open **WhatsApp → API Setup**.
   - Copy the test number's **Phone number ID** into `WA_PHONE_NUMBER_ID`, and the number itself into `BOT_NUMBER`.
   - Under the "To" field, add your own WhatsApp number and confirm the code Meta sends. A test number can only message numbers added here.
   - The access token on this page lasts about a day, which is fine for a first try. For a token that lasts, create a system user in your Meta Business settings, give it your app with the `whatsapp_business_messaging` permission, and generate a token for it. Put the token in `WA_TOKEN`.
3. Copy the **App secret** from **App settings → Basic** into `WA_APP_SECRET`.

You can move to a real number later from the same pages; only `WA_PHONE_NUMBER_ID`, `BOT_NUMBER` and perhaps `WA_TOKEN` change.

## 3. Point Meta's webhook at the relay

Set all six required secrets first, or Meta's check fails.

1. In **WhatsApp → Configuration**, edit the **Webhook**.
2. **Callback URL:** `https://<worker host>/whatsapp/webhook`
3. **Verify token:** the same string you put in `WA_VERIFY_TOKEN`.
4. Choose **Verify and save**. Meta calls the relay once, and the relay answers only if the token matches.
5. Under **Webhook fields**, subscribe to **`messages`**. That one field carries your replies, button taps and delivery statuses.

## 4. Create the message template

WhatsApp only lets a bot send free-form messages to a number that has messaged it in the last 24 hours. Outside that window the relay sends a short template instead, and tapping its button brings up the full prompt.

In **WhatsApp Manager → Message templates**, create a template:

- **Category:** Utility
- **Name:** `modisa_needs_you`
- **Language:** English (`en`)
- **Body:** `Modisa: {{1}} needs you: {{2}}. Tap Show to see it.` For the samples Meta asks for, use something like `my-project` and `Run a command`. The relay fills in the project name and a short title.
- **Button:** Quick reply, with the text `Show`

Meta rejects a template body that starts or ends with a variable. If you reword the body, keep some fixed text before `{{1}}` and after `{{2}}`.

Meta reviews templates, usually within minutes. Until yours is approved, prompts only reach you inside the 24-hour window; sending the bot any message opens it. If you use another name or language, set `TEMPLATE_NAME` and `TEMPLATE_LANG` to match. Any utility template works if it has two body variables (project, then title), neither at the very start nor the very end, and one quick-reply button.

## Billing

Billing is **off** unless you set `BILLING`, and that is the right setting for your own relay. With billing off the relay keeps no balances and charges nobody; it only applies `HOURLY_CAP`. Meta's own pricing for your WhatsApp Business account still applies to you as the account owner.

`trial` and `on` are for a relay that charges the people using it. Each message is then priced from `RATES_JSON` plus `MARKUP_PERCENT`, and skipped when a number's credit can't cover it.

## 5. Point Modisa at your relay

In Modisa, open **Settings → Phone (WhatsApp) → Advanced → Relay address**, enter

```
wss://<worker host>/link
```

and choose **Save**. Then link your number from the same Settings section: Modisa shows a code, and you send it to the bot from your phone. Each machine links on its own.

## Running it locally

```sh
npx wrangler dev
curl localhost:8787/health    # ok
```

`/health` works with no secrets. To try more, put values in a `.dev.vars` file in this folder, one `NAME=value` per line. Git ignores `.dev.vars`, so it is never committed.

## What the relay keeps

- **Machines:** a SHA-256 hash of each machine's key, never the key itself, plus the machine's name and linked number.
- **Numbers:** linked numbers, and the time of each message the bot sent them, for the hourly cap.
- **Prompts:** only while they are open. Their text is removed when they are answered or closed, or within 10 minutes of expiring, and the rest of the record goes an hour later.
- **Message ids:** ids of messages the bot sent are kept for 7 days, and ids of messages it received for a day, to catch repeats.

A clean-up runs every 10 minutes. Logs (`npx wrangler tail`) carry error types, counts and the name of any missing or bad setting: never prompt text, phone numbers, keys or tokens.
