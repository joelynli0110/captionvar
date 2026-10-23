/**
 * CaptionVAR v0.7 — conservative, narrow-domain checks on the ACTUAL displayed caption.
 * This is not general-purpose natural-language claim extraction. The gate extracts
 * a small allowlist of event assertions, refuses unrecognized claims, and renders
 * independent, deterministic text from the source events.
 */
const second = e => 60 * e.minute + e.second;
const lower = s => String(s || '').toLowerCase().replace(/[\u2010-\u2015]/g, '-');
const QUANTITIES = new Map([['zero',0],['one',1],['two',2],['three',3],['four',4],['five',5],['six',6],['seven',7],['eight',8],['nine',9],['ten',10]]);
const NUMBER = '(?:\\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten)';
const parseNumber = n => /^\d+$/.test(n) ? Number(n) : QUANTITIES.get(n);

function response(status, reason, evidence, fan, analyst, extracted = []) {
  return {status, reason, evidence, fan, analyst, extracted};
}

function facts(scenario) {
  const at = second(scenario);
  const events = scenario.events || [];
  const recent = events.filter(e => second(e) >= at - 90 && second(e) <= at);
  const recoveries = recent.filter(e => e.type === 'recovery' && e.zone === 'attacking_third');
  const shots = events.filter(e => e.type === 'shot');
  const passes = events.filter(e => e.type === 'pass' && e.team === scenario.team);
  return {recoveries, shots, passes, goals:events.filter(e=>e.type === 'goal'), at};
}

function recoveryCounts(scenario, f) {
  const n = f.recoveries.filter(e => e.team === scenario.team).length;
  const other = f.recoveries.filter(e => e.team !== scenario.team).length;
  const ids = f.recoveries.map(e => e.id);
  return {n, other, ids};
}

function getRecoveryCounts(caption) {
  const s = lower(caption);
  // Explicitly admit only a tiny, documented grammar; never guess a number.
  const verb = new RegExp(`\\b(?:recovered|regained|won back|win(?: the)? ball)\\b[^.!?]{0,75}?\\b(${NUMBER})\\s+times?\\b`, 'i');
  const noun = new RegExp(`\\b(${NUMBER})\\s+(?:attacking[- ]third[- ]ball\\s+|high\\s+)?(?:ball\\s+)?recoveries\\b`, 'i');
  const m = s.match(verb) || s.match(noun);
  if (!m) return null;
  const count = parseNumber(m[1]);
  const versus = new RegExp(`\\b(?:compared\\s+to|versus|vs\\.?)(?:\\s+just)?\\s+(${NUMBER})\\b`, 'i').exec(s);
  return {count, other:versus ? parseNumber(versus[1]):null};
}

function safeRecoveryOutput(scenario, f, status, reason, extracted) {
  const {n,other,ids} = recoveryCounts(scenario,f);
  const fan = `${scenario.team} recovered possession ${n} time${n===1?'':'s'} in the attacking third in the previous 90 seconds.`;
  const analyst = `Window ending ${scenario.minute}:${String(scenario.second).padStart(2,'0')}; attacking-third recoveries: ${scenario.team}=${n}, opposition=${other}. Event IDs: ${ids.join(', ')||'none'}. No pressing cause inferred.`;
  return response(status,reason,ids,fan,analyst,extracted);
}

export function verifyCaption(scenario, caption) {
  const s = lower(caption).trim();
  const f = facts(scenario);
  if (!s) return response('WITHHOLD','Empty candidate text.',[], 'No insight can be displayed.', 'Empty model output.');

  // A conspicuously garbled name / repetition is not publishable.
  if (/\b([a-z]{3,})\s+\1\b/i.test(s) || /northbridgebridge|riversideriverside/i.test(s)) {
    return response('WITHHOLD','The model produced repeated or malformed words; caption cannot be safely interpreted.',[],
      'The incoming description needs correction before publication.', 'Rejected malformed surface text.');
  }

  // Fail closed on explicit goals not in source. (An xG mention is checked separately.)
  const withoutXgTerm = s.replace(/\bexpected[- ]goals?\b/g, 'xg');
  const goalClaim = /\b(?:scor(?:e|es|ed|ing)|netted|equalis(?:ed|es)|equaliz(?:ed|es)|goal(?:s)?|hat[- ]trick|brace)\b/i.test(withoutXgTerm);
  if (goalClaim) {
    return response('WITHHOLD',f.goals.length === 0 ? 'The caption claims a goal, but no goal event exists in the supplied records.' : 'Goal claims are outside this MVP parser; human review required.',
      f.goals.map(e=>e.id),f.shots.length ? `A shot was recorded at ${scenario.minute}:${String(scenario.second).padStart(2,'0')}; no goal is confirmed.`:'No goal is confirmed by the event stream.',
      `Goal events available: ${f.goals.length}. The candidate cannot be released.`, ['goal assertion']);
  }

  // Shot-related xG estimates must have provenance; don't confuse xG with a scored goal.
  const xgClaim = /\bxg\b|expected[- ]goals?/i.test(s);
  if (xgClaim) {
    const measured = f.shots.filter(e=>typeof e.xg === 'number');
    if (!measured.length) return response('WITHHOLD','The caption mentions xG but the source supplies no xG estimate.',f.shots.map(e=>e.id),
      'A shot was recorded, but its xG is unavailable.',`Shot IDs: ${f.shots.map(e=>e.id).join(', ')||'none'}; xG estimator not supplied.`,['xG assertion']);
    return response('WITHHOLD','xG phrase detected, but numerical claim parsing is outside the supported caption grammar.', measured.map(e=>e.id),
      'Shot quality needs an additional check.','An xG value exists but was not automatically compared.', ['xG assertion']);
  }

  // Explicit 'final 90 seconds' implies end-of-match, not a rolling window.
  const finalWindow = /\b(?:final|last)\s+90\s+seconds?\s+of\s+the\s+match\b/i.test(s);
  // Pressing may appear BEFORE or AFTER the recovery claim. Recovery counts
  // alone do not establish how/why possession was won.
  const unsupportedCause = /\b(?:aggressive|relentless|high[- ]intensity)\s+pressing\b|\bpressing\b[^.!?]{0,90}\b(?:led to|caused|resulted in)\b|\b(?:came from|caused by|because of|thanks to|through|due to)\b[^.!?]{0,60}\bpressing\b/i.test(s);
  const dominates = /\b(?:dominates?|dominating|complete(?:ly)?\s+control|superiority|better side|best team|all season|clearly superior)\b/i.test(s);
  // A matching count is insufficient to approve unrelated clauses. This
  // list is a warning gate, NOT a general claim extractor. These claims are
  // intentionally removed by the deterministic safe rewrite.
  const unsupportedExtras = /\b(?:injur(?:y|ies|ed)|hurt|sidelined|corner(?:s)?|penalt(?:y|ies)|assist(?:s)?|offside|yellow card|red card|yellow cards|red cards|clean sheet|all season|star striker|coach|manager)\b/i.test(s);
  const multipleClauses = /\b(?:and|but|while|whereas|then|also|afterwards|meanwhile|which|who|because|with|alongside|despite|including|becoming|followed by|resulting)\b/i.test(s) || /[.!?]\s+\S/.test(s);
  // A mention of a different team's name without the primary team's name is
  // ambiguous; never attribute its count to the primary team by assumption.
  const otherNames = [...new Set((scenario.events || []).map(e=>e.team))].filter(name=>name!==scenario.team);
  const expectedStem = scenario.team.toLowerCase().replace(/\s+fc$|\s+united$/i,'');
  const nameMismatch = otherNames.some(name=>s.includes(name.toLowerCase().replace(/\s+fc$|\s+united$/i,''))) && !s.includes(expectedStem) && !/\bhome team\b/i.test(s);

  // We only verify explicit counts of attacking-third recoveries and simple
  // recorded-shot statements. Anything else is withheld, not silently approved.
  const looksLikeRecovery = /\b(?:recover(?:ed|ies)?|regained|won back|win(?: the)? ball)\b/i.test(s);
  if (looksLikeRecovery) {
    const reported = getRecoveryCounts(s);
    if (!reported) return response('WITHHOLD','A recovery was mentioned but its quantity could not be parsed reliably.',[],
      'The recovery claim requires review.','Unrecognized recovery-count phrase.');
    const {n,other,ids} = recoveryCounts(scenario,f);
    if (reported.count !== n || (reported.other !== null && reported.other !== other)) {
      return response('WITHHOLD',`Caption recovery totals (${reported.count}${reported.other===null?'':', opponent '+reported.other}) differ from the recorded totals (${n}, opponent ${other}).`,ids,
        'The recovery figures in the candidate do not match the event records.',`Source counts: ${scenario.team}=${n}, opponent=${other}.`,['recovery count']);
    }
    const warnings = [];
    if (unsupportedCause && !(scenario.events||[]).some(e=>e.type==='pressing_action')) warnings.push('pressing causality is unsupported');
    if (finalWindow) warnings.push('“final 90 seconds of the match” misstates a rolling 90-second window');
    if (dominates) warnings.push('long-term superiority or dominance is not established');
    if (unsupportedExtras) warnings.push('other event or player claims are not supported by this parser');
    if (multipleClauses && !unsupportedExtras && !dominates && !unsupportedCause) warnings.push('additional clauses are outside the verified claim grammar');
    if (nameMismatch) warnings.push('the team attribution is ambiguous');
    if (warnings.length) return safeRecoveryOutput(scenario,f,'QUALIFY',`The count matches, but ${warnings.join('; ')}.`, ['recovery count',...warnings]);
    return safeRecoveryOutput(scenario,f,'VERIFY','The parsed recovery count matches timestamped attacking-third events. Only this supported claim is verified, not arbitrary extra text.', ['recovery count']);
  }

  if (/\b(?:shot|attempt)\b/i.test(s) && f.shots.length && !dominates && !unsupportedCause) {
    return response('QUALIFY','A shot is supported, but only the verified event is safe to publish; surrounding prose is not fully parsed.',f.shots.map(e=>e.id),
      `${scenario.team} registered a shot.`, `Shot IDs: ${f.shots.map(e=>e.id).join(', ')}. xG unavailable unless supplied in the data.`, ['shot event']);
  }

  return response('WITHHOLD','The candidate does not match the limited supported claim grammar. Unrecognized prose is never auto-approved.',[],
    'This insight is awaiting review.','No supported claim could be extracted from the caption.');
}
