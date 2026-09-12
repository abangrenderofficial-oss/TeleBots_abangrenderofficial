import { routeCommand } from './commands/router.js';
import { matchesGroupEvent, handleGroupEvent } from './commands/connect.js';
import { routeBatchCallback, classifyBatchCallback } from './batch/router.js';
import { isAdminUser } from './core/auth.js';
import { routeFeatureUpdate } from './features/router.js';

export async function routeUpdate(req, res) {
  const update = req.body || {};
  const message = update.message;
  const query = update.callback_query;

  // Destination connection is its own domain.
  if (message && matchesGroupEvent(message)) {
    return handleGroupEvent({ message, req, res });
  }

  // Every supported slash command is owned by exactly one command module.
  if (message?.chat?.type === 'private') {
    const commandResult = await routeCommand({ message, req, res });
    if (commandResult !== false) return commandResult;
  }

  // Explicit batch callbacks are isolated from preview/edit callbacks.
  if (query?.message && isAdminUser(query.from) && classifyBatchCallback(query.data)) {
    return routeBatchCallback({ query, req, res });
  }

  // Non-command product behavior is split under lib/bot/features/.
  return routeFeatureUpdate(req, res);
}
