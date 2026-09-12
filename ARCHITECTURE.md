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
- Batch persistence -> `lib/explicit-batches.js`
- Worker execution -> `api/telegram-sendall.js`

A SEND ALL change must not require editing `/menu`, memory, AI, caption, connect, reset or preview modules.

## Feature ownership

All non-command live behavior is split under `lib/bot/features/`.

- AI/general chat -> `features/agent-chat.js`
- Incoming media processing / duplicate detection / preview ordering -> `features/media.js`
- Preview layout and edit UI -> `features/preview-ui.js`
- Preview inline-button callbacks -> `features/preview-callbacks.js`
- Single SEND / SEND AGAIN -> `features/send-one.js`
- Text input while an edit state is active -> `features/state-input.js`
- Focus/helper state -> `features/context.js`
- Non-command message routing -> `features/message-router.js`
- Feature routing only -> `features/router.js`

`api/telegram.js` remains in the repository only as historical compatibility/reference code. The production webhook router does not call it.

## Core ownership

- Command parsing -> `lib/bot/core/command.js`
- Admin identity -> `lib/bot/core/auth.js`
- Raw Telegram transport -> `lib/bot/core/telegram-client.js`
- Callback diagnostics -> `lib/bot/core/debug.js`
- Stable constants -> `lib/bot/core/constants.js`

Core files must not contain product/business behavior.

## Webhook rule

Normal bot operations must never choose a different production webhook route. Webhook registration belongs only to the dedicated repair/setup path. The production ingress remains `api/telegram-safe-destination.js`.

## Change discipline

Before editing code, identify the topic owner from this file. Modify only that owner plus its direct tests. If a change appears to require an unrelated module, stop and verify the boundary instead of patching across domains.

Examples:

- User asks to change `/menu` -> edit `commands/menu.js` only.
- User asks to change `/stop` -> edit `commands/stop.js` and, only if stop behavior itself changes, `batch/control.js`.
- User asks to change SEND ALL speed -> edit batch worker/start files only; never command files.
- User asks to change caption parsing -> edit media/format modules only; never webhook or batch reset.
- User asks to change reset behavior -> edit `batch/reset.js` only; never SEND ALL selection logic.
