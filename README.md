# Family Car Share

A small family car booking app with:

- Calendar-based car booking requests
- Telegram messages to parents for approval
- Approve/reject links for each request
- Kilometer cost calculator
- Copenhagen-area address autocomplete for destinations
- Round-trip cost estimate from `Havesvinget 14, 2950 Vedbaek`
- Responsive website layout that can be added to an iPhone home screen
- One parent approval is enough to approve a booking

## Run locally

```powershell
node server.js
```

Open `http://localhost:3000`.

## Configure Telegram

1. Ask your dad to open Telegram and message `@BotFather`.
2. He should send `/newbot`, choose a name, and copy the bot token.
3. Save the token locally:

```powershell
node scripts/telegram-setup.js --token "PASTE_TOKEN_HERE"
```

4. Ask your dad to open the new bot and send `/start`.
5. Run:

```powershell
node scripts/telegram-setup.js
```

The helper will save his chat ID in `.env` and send him a test message.

When deployed, set `PUBLIC_BASE_URL` to the real public website URL. Approval links need a public URL to work from your dad's phone.

Example:

```env
PORT=3000
PUBLIC_BASE_URL=https://your-car-share-app.example.com
TELEGRAM_BOT_TOKEN=123456:your-real-token
TELEGRAM_PARENT_CHAT_IDS=111111111,222222222
APPROVAL_SECRET=make-this-a-long-random-string
DEFAULT_KM_RATE=1.5
HOME_ADDRESS=Havesvinget 14, 2950 Vedbaek
SEARCH_RADIUS_KM=85
```

## iPhone use

After the app is hosted, open it in Safari on the iPhone, tap Share, then tap Add to Home Screen.

## Questions to decide next

## Recommended hosting

Use Render for the first hosted version. It is straightforward for a small Node app, supports environment variables, and gives you a public URL that Telegram approval links can use.

Deploy settings:

- Build command: leave blank
- Start command: `npm start`
- Environment: Node
- Environment variables: copy the values from `.env.example`, with real Telegram details

Important: `.env` is for your computer only and must not be uploaded to GitHub. Add the Telegram token and dad's chat ID in Render's Environment settings instead.

Render's free filesystem is temporary, so bookings stored in `data/bookings.json` can be lost when the service restarts. That is OK for a first family test, but the proper next step is adding a small hosted database.
