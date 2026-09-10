# TeleBots Abang Render

Private Telegram assistant for preparing, teaching, previewing and sending media captions.

## Core flow

1. Admin sends a photo or file to the bot in private chat.
2. Bot extracts/cleans/translates the title using saved rules and examples.
3. Bot appends the saved Abang Render footer while preserving Telegram hyperlinks.
4. Bot sends a preview back with **SEND**, **EDIT TITLE**, **TEACH**, and queue controls.
5. Approved items are copied to the configured destination chat/channel.
6. File statistics count Telegram documents only; photos are tracked in the queue but excluded from file totals.

## Required Vercel environment variables

- `TELEGRAM_BOT_TOKEN`
- `ADMIN_TELEGRAM_ID`
- `DESTINATION_CHAT_ID` (optional if configured through the bot)
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY` (optional until AI title extraction/translation is enabled)
- `OPENAI_MODEL` (optional)
- `SETUP_SECRET` (used once to register the Telegram webhook)

Never commit real tokens or keys to GitHub.

## Endpoints

- `/api/health` – safe configuration/health check
- `/api/telegram` – Telegram webhook
- `/api/register-webhook?key=...` – register the production webhook using `SETUP_SECRET`

## Database

Run `supabase/schema.sql` in a dedicated Supabase project for this bot. Do not point this bot at another product database unless intentionally sharing infrastructure.
