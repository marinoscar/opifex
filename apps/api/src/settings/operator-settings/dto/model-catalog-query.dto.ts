import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { MODEL_CONSUMERS } from '../../../supervisor/invocation/supervisor-model.config';

/**
 * Which consumer's model list `GET /api/operator-settings/supervisor-models`
 * is being asked for (#423, epic #419).
 *
 * ## Why a parameter rather than a second route
 *
 * The list is a function of one thing — the provider the named consumer is
 * currently set to — and everything else about the request is identical. A
 * `/chat-models` route beside `/supervisor-models` would be the same handler
 * twice, and the third consumer would be a third route; the vocabulary is
 * already closed and already declared once, so it belongs in the request as a
 * value.
 *
 * ## Why it defaults to the supervisor
 *
 * Compatibility, precisely: the route existed before there was a second
 * consumer and `apps/web` calls it with no parameters today (#391). A default
 * that meant anything else would silently repoint an existing client at a
 * different provider's catalogue. It is the one place a default for the
 * consumer is correct — `SupervisorModelCatalogService.list` deliberately
 * takes it as a required argument, so that the choice is made here, once,
 * where it is visible in the API document.
 */
export const modelCatalogQuerySchema = z.object({
  consumer: z.enum(MODEL_CONSUMERS).default('supervisor'),
});

export class ModelCatalogQueryDto extends createZodDto(
  modelCatalogQuerySchema,
) {}
