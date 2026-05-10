// select-winner.js — pure function for ranking candidates by verify metrics.
//
// pickWinner(candidates, objective) where candidates is an array of
// attemptRecord entries from epoch.js (must have .candidate + .verify fields).
//
// objective (from epoch spec `optimize` field, optional):
//   "max throughput"  — rank by verify.measured descending (default)
//   { score: "throughput - 0.001 * entity_count" }
//     — evaluated as a JS expression with throughput / entity_count / footprint_tiles
//       variables; trusted epoch content only.

export function pickWinner(candidates, objective = "max throughput") {
  const passing = candidates.filter((r) => r.verify?.pass);
  if (!passing.length) {
    return { winnerId: null, ranking: [], scores: [] };
  }

  const scored = passing
    .map((r) => ({ candidate: r.candidate, score: computeScore(r, objective), verify: r.verify }))
    .sort((a, b) => b.score - a.score);

  return {
    winnerId: scored[0].candidate,
    ranking: scored.map((s) => s.candidate),
    scores: scored.map((s) => ({ candidate: s.candidate, score: s.score })),
    objective,
  };
}

function computeScore(record, objective) {
  const measured = record.verify?.measured ?? 0;
  const entity_count = record.verify?.entity_count ?? 0;
  const footprint_tiles = record.verify?.footprint_tiles ?? 0;
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
