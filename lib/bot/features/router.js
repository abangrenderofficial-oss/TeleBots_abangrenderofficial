import { BUILD_VERSION } from '../core/constants.js';
import { handleFeatureMessage } from './message-router.js';
import { handlePreviewCallback } from './preview-callbacks.js';

export async function routeFeatureUpdate(req, res) {
  try {
    const update = req.body || {};
    let handled = false;

    if (update.message) handled = await handleFeatureMessage(update.message);
    if (!handled && update.callback_query) handled = await handlePreviewCallback(update.callback_query);

    return res.status(200).json({
      ok: true,
      handled: Boolean(handled),
      feature_router: true,
      build: BUILD_VERSION,
    });
  } catch (error) {
    console.error('Feature router error:', error);
    return res.status(200).json({
      ok: true,
      handled: false,
      feature_router: true,
      build: BUILD_VERSION,
      error: String(error?.message || error).slice(0, 500),
    });
  }
}
