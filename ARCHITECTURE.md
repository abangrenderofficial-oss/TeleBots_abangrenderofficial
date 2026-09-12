# TeleBots architecture ownership

## Non-negotiable rule

One user topic must map to one owned module/domain. Do not edit unrelated domains to implement a topic-specific change.

## Single production ingress

Telegram production webhook -> `api/telegram-safe-destination.js` -> `lib/bot/update-router.js`.

The ingress file contains no business logic. It only delegates.

## Command ownership

Every slash command has its own file under `lib/bot/commands/`.

- `/menu` -> `commands/menu.js`
- `/start`, `/help` -> `commands/help.js`
- `/whoami` -> `commands/whoami.js`
- `/version` -> `commands/version.js`
- `/aitest` -> `commands/aitest.js`
- `/stats` -> `commands/stats.js`
- `/total` -> `commands/total.js`
- `/pending` -> `commands/pending.js`
- `/memories` -> `commands/memories.js`
- `/remember` -> `commands/remember.js`
- `/forget` -> `commands/forget.js`
- `/clearchat` -> `commands/clearchat.js`
- `/setcaption` -> `commands/setcaption.js`
- `/stop` -> `commands/stop.js`
- `/resume` -> `commands/resume.js`
- `/resetbatch` -> `commands/resetbatch.js`
- `/connect` -> `commands/connect.js`

`commands/router.js` is registry-only. Do not put command behavior there.

## Batch ownership

- Batch creation / SEND ALL -> `lib/bot/batch/start.js`
- STOP / RESUME -> `lib/bot/batch/control.js`
- RESET BATCH -> `lib/bot/batch/reset.js`
- Batch callback matching only -> `lib/bot/batch/router.js`
- Shared worker/destination helpers -> `lib/bot/batch/shared.js`
- Batch persistence -> existing `lib/explicit-batches.js`
- Worker execution -> `api/telegram-sendall.js`

A SEND ALL change must not require editing `/menu`, memory, AI, caption, connect, or reset modules.

## Core ownership

- Command parsing -> `lib/bot/core/command.js`
- Admin identity -> `lib/bot/core/auth.js`
- Raw Telegram transport -> `lib/bot/core/telegram-client.js`
- Stable constants -> `lib/bot/core/constants.js`

Core files must not contain product/business behavior.

## Legacy feature engine

`api/telegram.js` is compatibility code for non-command behavior that has not yet been physically split: AI chat, media processing, preview formatting/editing, single SEND and format controls.

It is reachable only through `lib/bot/legacy-adapter.js` after command and explicit-batch routers decline an update. It must never own webhook registration, `/menu`, `/stop`, `/resume`, `/resetbatch` or SEND ALL batch creation again.

When a legacy feature is changed next, extract that feature into its own `lib/bot/features/<topic>.js` module first instead of adding more code to `api/telegram.js`.

## Webhook rule

Normal bot operations must never decide which production webhook URL Telegram uses. Webhook registration belongs only to the dedicated repair/setup path.

## Change discipline

Before editing code, identify the topic owner from this file. Modify only that owner plus its direct tests. If a change appears to require an unrelated module, stop and verify the boundary instead of patching across domains.
