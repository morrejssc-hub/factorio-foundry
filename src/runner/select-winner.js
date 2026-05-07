// select-winner.js — pure function for ranking candidates by audit metrics.
//
// pickWinner(candidates, objective) where candidates is an array of
// attemptRecord entries from epoch.js (must have .candidate + .audit fields).
//
// objective (from epoch yaml `optimize` field, optional):
//   "max throughput"  — rank by audit.measured descending (default)
//   { score: "throughput - 0.001 * entity_count" }
//     — evaluated as a JS expression with throughput / entity_count / footprint_tiles
//       variables; trusted epoch-yaml content only.

export function pickWinner(candidates, objective = "max throughput") {
  const passing = candidates.filter((r) => r.audit?.pass);
  if (!passing.length) {
    return { winnerId: null, ranking: [], scores: [] };
  }

  const scored = passing
    .map((r) => ({ candidate: r.candidate, score: computeScore(r, objective), audit: r.audit }))
    .sort((a, b) => b.score - a.score);

  return {
    winnerId: scored[0].candidate,
    ranking: scored.map((s) => s.candidate),
    scores: scored.map((s) => ({ candidate: s.candidate, score: s.score })),
    objective,
  };
}

function computeScore(record, objective) {
  const measured = record.audit?.measured ?? 0;
  const entity_count = record.audit?.entity_count ?? 0;
  const footprint_tiles = record.audit?.footprint_tiles ?? 0;
  const throughput = measured;

  if (typeof objective === "string") {
    return measured;
  }

  if (typeof objective === "object" && typeof objective.score === "string") {
    try {
      // eslint-disable-next-line no-new-func
      return new Function("throughput", "entity_count", "footprint_tiles",
        `return (${objective.score});`)(throughput, entity_count, footprint_tiles);
    } catch {
      return measured;
    }
  }

  return measured;
}
