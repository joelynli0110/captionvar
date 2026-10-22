// CaptionVAR v0.1: validates three *structured* claim types, not arbitrary natural language.
// The event records below are synthetic; no Premier League data is included.
const time = e => 60 * e.minute + e.second;

export function verifyScenario(scenario) {
  const {events, claim, team} = scenario;
  if (claim.type === 'pass_dominance') {
    const passes = events.filter(e => e.type === 'pass' && e.team === team);
    const n = passes.length;
    const good = passes.filter(e => e.successful === true).length;
    const rate = n ? Math.round(100 * good / n) : null;
    const evidence = passes.map(e => e.id);
    if (!n) return {status:'WITHHOLD',reason:'No passes recorded: cannot verify the accuracy figure.', evidence,
      fan:'There is not enough data to assess passing.', analyst:'No pass events in the measurement window.'};
    if (rate !== claim.rate) return {status:'WITHHOLD',reason:`Claimed ${claim.rate}%, but recorded ${good}/${n} (${rate}%).`, evidence,
      fan:'The displayed passing figure does not match the match events.',analyst:`Recorded: ${good}/${n} passes (${rate}%).`};
    if (n < 10) return {status:'QUALIFY',reason:`The percentage is correct, but only ${n} passes were observed. It cannot establish possession dominance.`,evidence,
      fan:`Northbridge completed both sampled passes. It is too early to draw a bigger conclusion.`,
      analyst:`Accuracy: ${good}/${n} = ${rate}% (sample n=${n}). Insufficient evidence for possession dominance.`};
    return {status:'QUALIFY',reason:'Pass accuracy alone does not establish dominance in possession.',evidence,
      fan:`Northbridge completed ${rate}% of sampled passes.`,analyst:`Pass accuracy ${good}/${n} (${rate}%). Possession is a separate metric.`};
  }
  if (claim.type === 'high_recoveries') {
    const end = 60 * scenario.minute + scenario.second;
    const matches = events.filter(e => e.type === 'recovery' && e.team === team && e.zone === 'attacking_third' && time(e) <= end && time(e) >= end - 90);
    const n = matches.length;
    const evidence = matches.map(e => e.id);
    if (n !== claim.count) return {status:'WITHHOLD',reason:`Claimed ${claim.count} recoveries; the event window contains ${n}.`,evidence,
      fan:'We cannot verify the reported pressing count.',analyst:`Attacking-third recoveries in the 90-second window: ${n}.`};
    return {status:'VERIFY',reason:`All ${n} attacking-third recoveries are supported by distinct, timestamped match events. Their cause has not been established.`,evidence,
      fan:`Northbridge regained possession ${n} times in the attacking third during the last 90 seconds.`,
      analyst:`${n} attacking-third recoveries in the last 90 s. Direct event IDs: ${evidence.join(', ')}. Tactical intent remains an interpretation.`};
  }
  if (claim.type === 'recovery_causality') {
    const end = 60 * scenario.minute + scenario.second;
    const inWindow = e => e.type === 'recovery' && e.zone === 'attacking_third' && time(e) <= end && time(e) >= end - 90;
    const home = events.filter(e => inWindow(e) && e.team === team);
    const away = events.filter(e => inWindow(e) && e.team !== team);
    const evidence = [...home, ...away].map(e => e.id);
    if (home.length !== claim.home_count || away.length !== claim.away_count) {
      return {status:'WITHHOLD', reason:`Recovery counts do not match: home ${home.length}/${claim.home_count}, away ${away.length}/${claim.away_count}.`, evidence,
        fan:'The reported recovery counts could not be verified.', analyst:`Recorded home: ${home.length}; away: ${away.length}.`};
    }
    // A recovery event alone cannot prove the tactic or causal mechanism that produced it.
    // This MVP does not infer causality from event frequency.
    return {status:'QUALIFY',reason:'Recovery counts match the events, but the input contains no pressing actions or causal attribution. Remove "aggressive pressing led to".', evidence,
      fan:`In the last 90 seconds, ${team} recovered the ball ${home.length} times in the attacking third, versus ${away.length} for the opposition.`,
      analyst:`Attacking-third recoveries (90 s): ${team} ${home.length}, opposition ${away.length}. Evidence: ${evidence.join(', ')}. Pressing cause: not established.`};
  }
  if (claim.type === 'xg') {
    const shots = events.filter(e => e.type === 'shot' && e.team === team);
    const withXg = shots.filter(e => typeof e.xg === 'number');
    const evidence = shots.map(e => e.id);
    if (!withXg.length) return {status:'WITHHOLD',reason:'Shot recorded, but no xG value or approved xG estimator is present. Do not invent one.',evidence,
      fan:'It was a shot on target, but the chance quality is not available.',
      analyst:'Shot S-502 recorded. xG: unavailable; no calibrated shot-quality model is supplied.'};
    const actual = withXg[0].xg;
    if (Math.abs(actual-claim.value)>0.005) return {status:'WITHHOLD',reason:`Claimed ${claim.value} xG; available event value is ${actual}.`,evidence,
      fan:'The published chance-quality estimate does not match the source.', analyst:`Source xG: ${actual}; claimed: ${claim.value}.`};
    return {status:'VERIFY',reason:'Claimed xG matches the supplied shot estimate.',evidence,
      fan:`That chance was rated ${actual} xG.`,analyst:`Recorded xG: ${actual}. Check estimator provenance before publication.`};
  }
  return {status:'WITHHOLD',reason:'Claim type not supported by the starter verifier.',evidence:[],fan:'This insight has not been verified.',analyst:'Unsupported structured claim.'};
}
