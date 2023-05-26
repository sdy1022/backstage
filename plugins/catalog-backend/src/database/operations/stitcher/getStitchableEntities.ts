/*
 * Copyright 2023 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { HumanDuration } from '@backstage/types';
import { Knex } from 'knex';
import { DbRefreshStateRow } from '../../tables';
import { durationToMs } from '../../../util/durationToMs';

// TODO(freben): There is no retry counter or similar. If items start
// perpetually crashing during stitching, they'll just get silently retried over
// and over again, for better or worse. This will be visible in metrics though.

/**
 * Finds entities that are marked for stitching.
 *
 * @remarks
 *
 * They are expected to already have the next_stitch_ticket set (by
 * markForStitching) so that their tickets can be returned with each item.
 *
 * All returned items have their next_stitch_at updated to be moved forward by
 * the given timeout duration. This has the effect that they will be picked up
 * for stitching again in the future, if it hasn't completed by that point for
 * some reason (restarts, crashes, etc).
 *
 */
export async function getStitchableEntities(options: {
  knex: Knex | Knex.Transaction;
  batchSize: number;
  stitchTimeout: HumanDuration;
}): Promise<
  Array<{
    entityRef: string;
    stitchTicket: string;
  }>
> {
  const { knex, batchSize, stitchTimeout } = options;

  let itemsQuery = knex<DbRefreshStateRow>('refresh_state').select(
    'entity_ref',
    'next_stitch_ticket',
  );

  // This avoids duplication of work because of race conditions and is
  // also fast because locked rows are ignored rather than blocking.
  // It's only available in MySQL and PostgreSQL
  if (['mysql', 'mysql2', 'pg'].includes(knex.client.config.client)) {
    itemsQuery = itemsQuery.forUpdate().skipLocked();
  }

  const items = await itemsQuery
    .whereNotNull('refresh_state.next_stitch_at')
    .andWhere('refresh_state.next_stitch_at', '<=', knex.fn.now())
    .orderBy('next_stitch_at', 'asc')
    .limit(batchSize);

  if (!items.length) {
    return [];
  }

  await knex<DbRefreshStateRow>('refresh_state')
    .whereIn(
      'entity_ref',
      items.map(i => i.entity_ref),
    )
    .update({
      next_stitch_at: nowPlus(knex, stitchTimeout),
    });

  return items.map(i => ({
    entityRef: i.entity_ref,
    stitchTicket: i.next_stitch_ticket!,
  }));
}

function nowPlus(knex: Knex, duration: HumanDuration): Knex.Raw {
  const seconds = durationToMs(duration) / 1000;
  if (knex.client.config.client.includes('sqlite3')) {
    return knex.raw(`datetime('now', ?)`, [`${seconds} seconds`]);
  } else if (knex.client.config.client.includes('mysql')) {
    return knex.raw(`now() + interval ${seconds} second`);
  }
  return knex.raw(`now() + interval '${seconds} seconds'`);
}
