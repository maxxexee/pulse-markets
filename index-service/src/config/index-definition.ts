/**
 * Identifier of the published index definition.
 *
 * Bumped whenever the basket, the signal set, the weights or the calibration
 * changes, because markets settle against a specific definition and a snapshot
 * that cannot name its own definition cannot be used to resolve one. The
 * definition itself is published under `definitions/<id>.json` and embedded in
 * every snapshot, so this string is a name, not the terms.
 */
export const ACTIVE_DEFINITION_ID = 'pulse-attention-v5';

/**
 * Cap on any single constituent weight inside a signal.
 *
 * Drawn from the basket as measured, not from taste: over 30 days of pageviews
 * the largest constituent carried 40.1 percent of volume and the smallest 0.4.
 * Uncapped, a level move would mostly be one page's traffic; at 25 percent the
 * largest name still leads the index but cannot define it.
 */
export const CONSTITUENT_WEIGHT_CAP = 0.25;

/**
 * Days of history behind every anchor.
 *
 * Long enough to span a quiet month and a busy one, short enough that an anchor
 * still describes how much attention the entity normally gets. Anchors are
 * frozen for the life of the definition, so this window is the base period and
 * recalibrating is a new definition id.
 */
export const CALIBRATION_DAYS = 180;
