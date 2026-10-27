# CaptionVAR: submission text

The text for the hackathon's Project Pitch / Description field. Its numbers are checked against `public/traces/baselines-summary.json` by `npm test`, like the README's.

## One line

Everyone checks the numbers. But 10 of the 11 errors our narrator made on its own weren't numbers: they were who did what to whom. CaptionVAR checks those too, and we measured it: an LLM judge stopped 4 of the 11, CaptionVAR stopped all 11.

## Description

**What we built.** CaptionVAR is a multi-agent system for live football commentary that puts a VAR check between the model and the screen. A Narrator agent writes a caption for each key moment, an Analyst explains why it matters, and a Recap writer sums up each half. A blind Claim Extractor lists what each line claims without seeing the facts. A referee written in code checks every claim against the match events recorded so far and cites them. An Editor gets two tries to fix a failed caption; after that, the caption is built straight from the true facts.

**Microsoft technology.** Every agent runs on a Microsoft Foundry deployment (gpt-4.1-mini, and gpt-4.1-nano for comparison), orchestrated as a Microsoft Agent Framework workflow with conditional edges. The referee is an MCP server, which GitHub Copilot can use as well. Every agent call and every referee call is traced with OpenTelemetry into the Application Insights resource connected to the Foundry project.

**What it does.** It turns a synthetic event stream into checked captions, lines of context, recaps and a machine-readable overlay feed. Each is personalized for a fan or an analyst, a club, a player, and four languages written from the checked facts. A whole match costs about $0.18, with a median of 3.7 s from moment to air.

**The problem it solves.** A language model can describe a match well and still name the wrong player, and a broadcaster can't air that. Asking a second model to judge the first is not enough. Over five matches, an LLM judge caught every planted error but stopped only 4 of the 11 errors the narrator made on its own; CaptionVAR stopped all 11. It missed one planted superlative, which a code guard added since now flags. The matches have not yet been re-run with that guard.

Live demo: https://joelynli0110.github.io/captionvar/ · Code: https://github.com/joelynli0110/captionvar
