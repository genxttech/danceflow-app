/**
 * Deterministically-unique synthetic run id generation and propagation.
 *
 * One id is generated per top-level runner invocation and threaded through
 * every suite, every audit row, and every tagged note field (e.g. a
 * synthetic client's `notes` column) created during that run, so any
 * record can be traced back to the exact execution that created it.
 */

const RUN_ID_PREFIX = "syn";

export function generateSyntheticRunId(): string {
  return `${RUN_ID_PREFIX}_${crypto.randomUUID()}`;
}

const RUN_ID_PATTERN = /^syn_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSyntheticRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value);
}

/** Tag embedded in free-text fields (client notes, appointment notes, etc.)
 * so a human glancing at a record can immediately tell it's synthetic and
 * which run produced it, independent of the audit table. */
export function syntheticTag(runId: string): string {
  return `[synthetic-test:${runId}]`;
}
