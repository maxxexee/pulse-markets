/**
 * Identifier of the published index definition.
 *
 * Bumped whenever the basket or the signal set changes, because markets settle
 * against a specific definition and a snapshot that cannot name its own
 * definition cannot be used to resolve one.
 */
export const INDEX_DEFINITION_ID = 'pulse-attention-v4';
