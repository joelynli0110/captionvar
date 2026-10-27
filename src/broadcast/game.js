/**
 * Beat the VAR: the viewer calls which claims in a draft are false before
 * the referee's verdict is shown, and the call is scored against it.
 */
/** Claims the viewer can call in Beat the VAR: those with words of their own in the draft. */
export function callableClaims(decision) {
  const inText = new Set(decision.segments.filter(s => s.claim).map(s => s.claim));
  return decision.verdict.claims.filter(c => inText.has(c.id) && !c.framing);
}

/** What the referee found false in a draft, as a set of claim ids. */
export function falseClaims(decision) {
  return new Set(callableClaims(decision).filter(c => c.status !== 'supported').map(c => c.id));
}

/** Score one call: the claims the viewer flagged against the ones the referee rejected. */
export function scoreCall(decision, flagged) {
  const truth = falseClaims(decision);
  const caught = [...flagged].filter(id => truth.has(id)).length;
  const falseAlarms = [...flagged].filter(id => !truth.has(id)).length;
  return { caught, missed: truth.size - caught, falseAlarms, total: truth.size, right: caught === truth.size && falseAlarms === 0 };
}

