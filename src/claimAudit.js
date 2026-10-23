/**
 * CaptionVAR v0.8: explain the two deliberately composed claims of the
 * Hackathon showcase without relying on manually stored decision labels.
 * This is NOT a general natural-language claim extraction or fact-checker.
 */
const asSeconds = e => e.minute * 60 + e.second;
const NUMBER = new Map([['zero',0],['one',1],['two',2],['three',3],['four',4],['five',5],['six',6],['seven',7],['eight',8],['nine',9],['ten',10]]);
const parseCount = text => /^\d+$/.test(text) ? Number(text) : NUMBER.get(text);

export function auditMixedClaims(scenario, caption) {
  if (scenario.showcase !== 'mixed_claims') return [];
  const s = String(caption ?? '').toLowerCase().replace(/[\u2010-\u2015]/g,'-');
  const at = asSeconds(scenario);
  const events = (scenario.events || []).filter(e => asSeconds(e) <= at && asSeconds(e) >= at - 90);
  const recoveries = events.filter(e => e.type === 'recovery' && e.team === scenario.team && e.zone === 'attacking_third');
  const goals = events.filter(e => e.type === 'goal' && e.team === scenario.team);
  const byScorer = new Map();
  for (const e of goals) {
    if (e.confirmed === true && typeof e.scorer_id === 'string' && e.scorer_id.trim()) {
      byScorer.set(e.scorer_id, [...(byScorer.get(e.scorer_id) || []), e.id]);
    }
  }
  const hatTrickProof = [...byScorer.values()].find(ids => ids.length >= 3) || [];
  const match = s.match(/\b(?:recovered|regained|won back)\b[^.!?]{0,90}?\b(\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten)\s+times?\b/i);
  const reported = match ? parseCount(match[1]) : null;
  const correctTeam = s.includes(scenario.team.toLowerCase().replace(/\s+fc$/, ''));
  const recoverySupported = correctTeam && reported !== null && reported === recoveries.length;
  const recovery = {
    key:'recoveries', label:'Claim 1 · Attacking-third recoveries', supported:recoverySupported,
    detail:recoverySupported
      ? `Caption reports ${reported}; the rolling 90-second event window contains ${recoveries.length} matching recoveries.`
      : `Recovery count or team cannot be established from the supported parser (recorded count: ${recoveries.length}).`,
    evidence:recoverySupported ? recoveries.map(e=>e.id) : []
  };
  const mentionsHatTrick = /\bhat[- ]trick\b/i.test(s);
  const hatTrickSupported = mentionsHatTrick && hatTrickProof.length >= 3;
  const hatTrick = {
    key:'hat-trick',label:'Claim 2 · Hat-trick',supported:hatTrickSupported,
    detail:mentionsHatTrick
      ? (hatTrickSupported ? 'Three confirmed goals attributed to the same scorer are present in the supplied records.' : `No three-goal, scorer-attributed proof in the supplied event window (goals recorded: ${goals.length}); a hat-trick cannot be verified.`)
      : 'No recognizable hat-trick claim to check; this showcase parser cannot certify additional prose.',
    evidence:hatTrickSupported ? hatTrickProof.slice(0,3) : []
  };
  return [recovery,hatTrick];
}
