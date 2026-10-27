/**
 * The referee's tools: name, the factbox operation behind each one, and the
 * input schema. Shared by the MCP server (scripts/referee-mcp.mjs) and the
 * A2A server (scripts/referee-a2a.mjs), so both accept exactly the same input.
 */
import { z } from 'zod';

const index = z.number().int().min(0).describe('Moment index, from list_moments');
const text = z.string().describe('The caption, exactly as written');
const verdict = z.record(z.string(), z.any()).describe('A verdict returned by check_caption');
const claim = z.record(z.string(), z.any());
const scope = z.enum(['caption', 'insight', 'recap']).optional()
  .describe("What is being checked: a moment's caption (default), its 'why it matters' line, or a recap sentence");
const recap = z.enum(['HT', 'FT']).optional().describe('For scope "recap": the half-time or full-time recap');

/**
 * Tools, in the order an agent workflow uses them. `op` is the factbox
 * operation behind each one; the Python client maps its calls through it.
 */
export const TOOLS = [
  {
    name: 'match_info', op: 'info', title: 'Match info',
    description: 'Match id, clubs and number of captionable moments of the synthetic match.',
    input: {},
  },
  {
    name: 'list_moments', op: 'moments', title: 'List moments',
    description: 'Every captionable moment (goals, shots, cards, substitutions, sprints, pressing spells) with the facts and recent actions a narrator may use.',
    input: {},
  },
  {
    name: 'extractor_view', op: 'extractor_packet', title: 'What the claim extractor may see',
    description: 'The caption and the squad lists for one moment, and nothing about what actually happened, so claims are reported as written.',
    input: { index: index.optional(), text, scope, recap },
  },
  {
    name: 'check_caption', op: 'verify', title: 'VAR check a caption',
    description: 'Check every claim of a caption (or a line of context, or a recap sentence) against the match events recorded up to its moment, or to the end of the half for a recap. Returns each claim as supported, contradicted or unverifiable with evidence event IDs, and an overall verdict: VERIFY (airs as written), QUALIFY (a detail is removed) or WITHHOLD (the main claim is false). Lines of context and recap sentences air only on VERIFY.',
    input: { index: index.optional(), text, extracted: z.array(claim).describe('Claims from the extractor: kind, span and the asserted values'), scope, recap },
  },
  {
    name: 'editor_view', op: 'editor_packet', title: 'What the editor may see',
    description: 'The failed caption, the verdict on each claim and the true facts of the moment, for a rewrite.',
    input: { index, text, verdict },
  },
  {
    name: 'caption_from_data', op: 'template', title: 'Caption built from the data',
    description: 'A safe English caption rendered straight from the verified facts, used when no written version passes.',
    input: { index, verdict: verdict.optional() },
  },
  {
    name: 'moment_header', op: 'decision_header', title: 'Moment header',
    description: 'Sequence number, match time, moment type and facts of one moment, as recorded in a trace.',
    input: { index },
  },
  {
    name: 'list_insight_moments', op: 'insight_moments', title: 'Moments that get a line of context',
    description: 'Indexes of the moments (goals, big chances, pressing spells, possession reports) that get a "why it matters" line after their caption.',
    input: {},
  },
  {
    name: 'analyst_view', op: 'analyst_packet', title: 'What the analyst may see',
    description: 'For one moment: its aired caption, its facts and the running numbers behind it (team totals, xG, minutes since the previous shot or goal, recent possession, the player\'s match totals).',
    input: { index, caption: z.string().optional() },
  },
  {
    name: 'list_recaps', op: 'recaps', title: 'Recaps',
    description: 'The half-time and full-time recaps, with the event each one closes on.',
    input: {},
  },
  {
    name: 'recap_view', op: 'recap_packet', title: 'What the recap writer may see',
    description: 'Everything recorded up to the end of the half or match: score, goals, bookings, possession, team totals and leading players.',
    input: { recap: z.enum(['HT', 'FT']) },
  },
  {
    name: 'line_editor_view', op: 'line_editor_packet', title: 'What the line editor may see',
    description: 'A failed line of context or recap sentence, the verdict on each claim and the true numbers, for one rewrite.',
    input: { scope: z.enum(['insight', 'recap']), index: index.optional(), recap, text, verdict },
  },
  {
    name: 'test_analyst_insight', op: 'simulated_insight', title: 'Test analyst line',
    description: 'The built-in test analyst\'s line of context for a moment, with its claims; a plant adds one wrong number. Used for offline runs.',
    input: { index, plant: z.string().nullable().optional() },
  },
  {
    name: 'test_recap', op: 'simulated_recap', title: 'Test recap',
    description: 'The built-in test recap for HT or FT as sentences with their claims; a plant adds one wrong name or number. Used for offline runs.',
    input: { recap: z.enum(['HT', 'FT']), plant: z.string().nullable().optional() },
  },
  {
    name: 'test_narrator_caption', op: 'simulated', title: 'Test narrator caption',
    description: 'The built-in test narrator\'s caption for a moment, with its claims and any deliberately planted error. Used for offline runs without a model.',
    input: { index, seed: z.string().optional() },
  },
];

/** The tool behind the A2A skill of the same name. */
export const CHECK_CAPTION = TOOLS.find(t => t.name === 'check_caption');
