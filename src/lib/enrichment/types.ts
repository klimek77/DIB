// Shared contract for the async enrichment path (F-03). The queue message
// carries ONLY the submission id — the DB row is the single source of truth,
// so the consumer always re-reads fresh state rather than trusting the payload.
// S-01 (producer) and the consumer Worker both depend on this one shape.

export interface EnrichmentMessage {
  submissionId: string;
}
