"""Score what aired in a trace with Microsoft Foundry's built-in evaluators.

    python agents/foundry_eval.py --trace public/traces/foundry-demo.json

A second opinion next to the code referee. The Azure AI Evaluation SDK
(azure-ai-evaluation, the evaluators behind the Foundry portal's Evaluation
page) reads every text that aired and the facts the agent that wrote it was
given, and scores it:

  groundedness  is every statement backed by those facts? 1-5, pass at 3 or more
  coherence     does it read as one clear answer to its brief? 1-5, pass at 3
  fluency       is it well written? 1-5, pass at 3

Three kinds of text: captions, "why it matters" lines and recap sentences.
Captions are split by what the referee did: verified (first draft aired),
trimmed (a detail failed, the editor removed it), withheld then corrected (a
core fact failed, the editor fixed it) and built from data (template). Lines
and recap sentences are verified or rewritten.

The same evaluators also score the FIRST drafts the referee stopped, with the
same facts. Each is labelled with what is known about it: a planted red-team
error, an error the narrator made on its own (checked by hand), a true detail
the referee flagged by mistake (checked by hand), or unreviewed. That shows
whether a model judge given the facts catches the errors the referee caught.

The facts are rebuilt from the match seed with the same code the agents used
(the factbox, over MCP): for a caption, what the narrator was given; for a
line, what the Analyst was given; for a recap, what the recap writer was
given. Squad lists are left out, as for the LLM judge in Evaluation v1.

Model: the evaluators call a chat deployment in the same Foundry resource.
    FOUNDRY_PROJECT_ENDPOINT  https://<resource>.services.ai.azure.com/api/projects/<project>
    FOUNDRY_MODEL             deployment name, e.g. gpt-4.1-mini
Optional:
    AZURE_OPENAI_ENDPOINT     default https://<resource>.openai.azure.com/, from the project endpoint
    AZURE_OPENAI_DEPLOYMENT   overrides FOUNDRY_MODEL for the evaluators
    AZURE_OPENAI_API_VERSION  default: the SDK's
Sign-in: DefaultAzureCredential (az login). No keys.

Options:
    --dry-run          build every evaluator input and write it to JSONL; no Azure calls
    --limit N          only the first N items (a cheap trial)
    --evaluators LIST  comma-separated, from groundedness,coherence,fluency,relevance
                       (default groundedness,coherence,fluency)
    --workers N        parallel evaluator calls (default 4)
    --log-to-foundry   also upload the results to the Foundry project (Evaluation page);
                       best effort, after the local results are written

Needs `pip install -r agents/requirements-eval.txt` and Node.js (for the factbox).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

PACKAGE = "azure-ai-evaluation"
PACKAGE_VERSION = "1.16.9"
DEFAULT_EVALUATORS = ("groundedness", "coherence", "fluency")
# name -> (SDK class, the input columns it reads)
EVALUATORS = {
    "groundedness": ("GroundednessEvaluator", ("response", "context")),
    "coherence": ("CoherenceEvaluator", ("query", "response")),
    "fluency": ("FluencyEvaluator", ("response",)),
    "relevance": ("RelevanceEvaluator", ("query", "response")),
}
THRESHOLD = 3  # the SDK's default for all four: a score of 3 or more passes
KINDS = ("caption", "why_it_matters", "recap_sentence")
CAPTION_BUCKETS = ("verified", "trimmed", "withheld_then_corrected", "built_from_data")
LINE_BUCKETS = ("verified", "rewritten")
TRUTHS = ("planted_error", "own_error", "true_detail_flagged", "unreviewed")
RECAP_NAMES = {"HT": "half-time", "FT": "full-time"}
# Azure OpenAI's token audience. The SDK asks for https://ai.azure.com/.default;
# the Azure OpenAI endpoint is documented for this one.
AOAI_SCOPE = "https://cognitiveservices.azure.com/.default"

MEASURED = (
    "Microsoft Foundry's built-in evaluators (azure-ai-evaluation) scored each text against the facts the agent "
    "that wrote it was given. 'aired': every caption, line of context and recap sentence that aired. "
    "'first_drafts': the first drafts the code referee did not pass, scored the same way; a groundedness 'fail' "
    "means the evaluator also found the draft not backed by the facts. Scores are 1-5; 3 or more passes. "
    "The evaluators are a model judge: their scores are an independent opinion, not ground truth. "
    "The groundedness rubric also rewards completeness, so a short text that is true but leaves facts out "
    "can score below 5; compare pass rates between groups rather than reading one mean on its own."
)


# ----------------------------------------------------------------- inputs


def decision_index(decision: dict) -> int:
    return int(decision["id"].split("-")[1]) - 1


def caption_bucket(decision: dict) -> str:
    if decision["aired"]["by"] == "template":
        return "built_from_data"
    return {"VERIFY": "verified", "QUALIFY": "trimmed"}.get(decision["verdict"]["status"], "withheld_then_corrected")


def line_bucket(line: dict) -> str:
    return "verified" if line["verdict"]["status"] == "VERIFY" else "rewritten"


def referee_flags(attempt: dict) -> str:
    return " | ".join(f"{f.get('span')}: {f.get('note') or f.get('status')}" for f in attempt.get("flags") or [])


def load_adjudication(path: str | None, trace: dict) -> dict:
    """Hand checks of the referee's flags, used only if they were made on this very run."""
    if not path or not Path(path).exists():
        return {}
    adj = json.loads(Path(path).read_text(encoding="utf-8"))
    if adj.get("run", {}).get("generated_at") != trace.get("generated_at"):
        return {}
    return adj


def draft_truth(scope: str, decision_id: str, planted: bool, adj: dict) -> tuple[str, str | None]:
    """What is known about a first draft the referee stopped."""
    if scope == "caption":
        case = adj.get("cases", {}).get(decision_id)
        if planted:
            return "planted_error", None
        if case:
            return ("own_error" if case[0] == "real" else "true_detail_flagged"), case[1]
        return "unreviewed", None
    lines = adj.get("lines", {})
    if scope == "why_it_matters":
        if decision_id in lines.get("planted_not_present", {}):
            return "true_detail_flagged", lines["planted_not_present"][decision_id]
        if planted:
            return "planted_error", None
        if decision_id in lines.get("false_alarms", {}):
            return "true_detail_flagged", lines["false_alarms"][decision_id]
        return "unreviewed", None
    return ("planted_error" if planted else "unreviewed"), None


def facts_text(view: dict) -> str:
    return json.dumps(view, ensure_ascii=False, indent=1)


def without_squads(packet: dict) -> dict:
    return {k: v for k, v in packet.items() if k not in ("team_players", "index")}


async def gather_contexts(trace: dict, factbox) -> dict:
    """The facts each agent was given, rebuilt from the match seed by the factbox."""
    from run_baselines import facts_view

    packets = {p["index"]: p for p in await factbox.call("moments")}
    out = {"caption": {}, "why_it_matters": {}, "recap": {}, "mismatches": []}
    for d in trace["decisions"]:
        i = decision_index(d)
        p = packets.get(i)
        if not p or p["minute"] != d["display_minute"] or p["moment_type"] != d["type"]:
            out["mismatches"].append(d["id"])
            continue
        out["caption"][d["id"]] = facts_view(p)
        if d.get("insight"):
            # The Analyst was given the caption that aired, and the running numbers behind it.
            packet = await factbox.call("analyst_packet", index=i, caption=d["aired"]["text"])
            out["why_it_matters"][d["id"]] = without_squads(packet)
    for r in trace.get("recaps") or []:
        out["recap"][r["recap"]] = without_squads(await factbox.call("recap_packet", recap=r["recap"]))
    return out


def build_items(trace: dict, contexts: dict, adj: dict | None = None) -> list[dict]:
    """One row per text to score: what aired, and each first draft the referee stopped."""
    adj = adj or {}
    items: list[dict] = []

    def add(**row) -> None:
        row["item_id"] = f"{row['decision_id']}:{row['kind']}:{row['set']}"
        items.append(row)

    for d in trace["decisions"]:
        facts = contexts["caption"].get(d["id"])
        if facts is None:
            continue
        where = f"{d['display_minute']} {d['type']}"
        base = {"decision_id": d["id"], "minute": d["display_minute"], "moment_type": d["type"]}
        query = f"Write one live broadcast caption for this moment of the match: {where}."
        planted = (d.get("planted_error") or {}).get("kind")
        add(**base, set="aired", kind="caption", bucket=caption_bucket(d), truth="", author=d["aired"]["by"],
            planted=planted or "", first_status=d["verdict"]["status"], referee_flags="", hand_check="",
            query=query, response=d["aired"]["text"], context=facts_text(facts))
        if d["verdict"]["status"] != "VERIFY":
            first = d["attempts"][0]
            truth, note = draft_truth("caption", d["id"], bool(planted), adj)
            add(**base, set="first_draft", kind="caption", bucket=d["verdict"]["status"].lower(), truth=truth,
                author=first["author"], planted=planted or "", first_status=d["verdict"]["status"],
                referee_flags=referee_flags(first), hand_check=note or "",
                query=query, response=first["text"], context=facts_text(facts))

        line = d.get("insight")
        facts = contexts["why_it_matters"].get(d["id"])
        if line and facts is not None:
            query = f"In one line, say why this moment matters: {where}."
            planted = (line.get("planted_error") or {}).get("kind")
            if line.get("aired"):
                add(**base, set="aired", kind="why_it_matters", bucket=line_bucket(line), truth="",
                    author=line["aired"]["by"], planted=planted or "", first_status=line["verdict"]["status"],
                    referee_flags="", hand_check="", query=query, response=line["aired"]["text"], context=facts_text(facts))
            if line["verdict"]["status"] != "VERIFY":
                first = line["attempts"][0]
                truth, note = draft_truth("why_it_matters", d["id"], bool(planted), adj)
                add(**base, set="first_draft", kind="why_it_matters", bucket=line["verdict"]["status"].lower(),
                    truth=truth, author=first["author"], planted=planted or "", first_status=line["verdict"]["status"],
                    referee_flags=referee_flags(first), hand_check=note or "",
                    query=query, response=first["text"], context=facts_text(facts))

    for r in trace.get("recaps") or []:
        facts = contexts["recap"].get(r["recap"])
        if facts is None:
            continue
        query = f"Write the {RECAP_NAMES.get(r['recap'], r['recap'])} recap of the match, one sentence at a time."
        for n, s in enumerate(r["sentences"]):
            base = {"decision_id": f"{r['id']}.{n + 1}", "minute": r["display_minute"], "moment_type": "recap"}
            planted = (s.get("planted_error") or {}).get("kind")
            if s.get("aired"):
                add(**base, set="aired", kind="recap_sentence", bucket=line_bucket(s), truth="", author=s["aired"]["by"],
                    planted=planted or "", first_status=s["verdict"]["status"], referee_flags="", hand_check="",
                    query=query, response=s["aired"]["text"], context=facts_text(facts))
            if s["verdict"]["status"] != "VERIFY":
                first = s["attempts"][0]
                truth, note = draft_truth("recap_sentence", base["decision_id"], bool(planted), adj)
                add(**base, set="first_draft", kind="recap_sentence", bucket=s["verdict"]["status"].lower(), truth=truth,
                    author=first["author"], planted=planted or "", first_status=s["verdict"]["status"],
                    referee_flags=referee_flags(first), hand_check=note or "",
                    query=query, response=first["text"], context=facts_text(facts))
    return items


def write_jsonl(items: list[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for row in items:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


# ------------------------------------------------------------------ model


class AzureOpenAICredential:
    """Wraps a credential so every token is for Azure OpenAI's audience, whatever scope is asked for."""

    def __init__(self, inner) -> None:
        self.inner = inner

    def get_token(self, *scopes, **kwargs):
        return self.inner.get_token(AOAI_SCOPE, **kwargs)


def aoai_endpoint(env: dict) -> str:
    """The Azure OpenAI endpoint of the Foundry resource behind the project."""
    if env.get("AZURE_OPENAI_ENDPOINT"):
        return env["AZURE_OPENAI_ENDPOINT"]
    project = env.get("FOUNDRY_PROJECT_ENDPOINT", "")
    host = urlparse(project).hostname or ""
    m = re.fullmatch(r"([a-z0-9-]+)\.services\.ai\.azure\.com", host, flags=re.I)
    if not m:
        raise SystemExit("Set FOUNDRY_PROJECT_ENDPOINT (https://<resource>.services.ai.azure.com/api/projects/<project>) "
                         "or AZURE_OPENAI_ENDPOINT.")
    return f"https://{m.group(1)}.openai.azure.com/"


def model_config(env: dict) -> dict:
    deployment = env.get("AZURE_OPENAI_DEPLOYMENT") or env.get("FOUNDRY_MODEL")
    if not deployment:
        raise SystemExit("Set FOUNDRY_MODEL (or AZURE_OPENAI_DEPLOYMENT) to the deployment name, e.g. gpt-4.1-mini.")
    config = {"type": "azure_openai", "azure_endpoint": aoai_endpoint(env), "azure_deployment": deployment}
    if env.get("AZURE_OPENAI_API_VERSION"):
        config["api_version"] = env["AZURE_OPENAI_API_VERSION"]
    return config


def make_evaluators(names: list[str], config: dict, credential) -> dict:
    import azure.ai.evaluation as sdk

    return {n: getattr(sdk, EVALUATORS[n][0])(config, credential=credential, threshold=THRESHOLD) for n in names}


def column_mapping(names: list[str]) -> dict:
    return {n: {"column_mapping": {c: "${data." + c + "}" for c in EVALUATORS[n][1]}} for n in names}


def run_evaluate(data: Path, evaluators: dict, workers: int) -> dict:
    """Score every row with the SDK's evaluate(), locally (nothing is uploaded here)."""
    from azure.ai.evaluation import evaluate

    # The SDK runs each evaluator on a thread of the same pool its rows use, so a
    # pool no larger than the number of evaluators deadlocks (seen with 1.16.9).
    # `workers` is the number of rows scored at once, on top of those threads.
    os.environ["PF_WORKER_COUNT"] = str(max(1, workers) + len(evaluators))
    return evaluate(data=str(data), evaluators=evaluators, evaluator_config=column_mapping(list(evaluators)))


def log_to_foundry(result: dict, evaluators: dict, project: str, name: str, credential) -> str | None:
    """Upload finished results to the project's Evaluation page.

    evaluate(azure_ai_project=...) uploads before it returns, so a failed upload
    would lose the scores. Instead the scores are computed and saved first, then
    sent with the same helper evaluate() uses (pinned SDK version)."""
    import pandas as pd
    from azure.ai.evaluation._evaluate._evaluate import _map_names_to_builtins
    from azure.ai.evaluation._evaluate._utils import _log_metrics_and_instance_results_onedp

    return _log_metrics_and_instance_results_onedp(
        result["metrics"], pd.DataFrame(result["rows"]), project, name,
        _map_names_to_builtins(evaluators, {}), tags={"app": "captionvar"}, credential=credential)


# ---------------------------------------------------------------- results


def number(value):
    if value is None or isinstance(value, str):
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) else f


def text(value):
    return value if isinstance(value, str) else None


def scores_from_rows(rows: list[dict], names: list[str]) -> dict:
    """item_id -> evaluator -> {score, result, reason}, from evaluate()'s rows."""
    out = {}
    for row in rows:
        item = row.get("inputs.item_id")
        out[item] = {}
        for n in names:
            score = number(row.get(f"outputs.{n}.{n}"))
            result = text(row.get(f"outputs.{n}.{n}_result"))
            if score is not None and result not in ("pass", "fail"):
                result = "pass" if score >= THRESHOLD else "fail"
            out[item][n] = {"score": score, "result": result if score is not None else "error",
                            "reason": text(row.get(f"outputs.{n}.{n}_reason"))}
    return out


def tally(items: list[dict], scores: dict, names: list[str]) -> dict:
    out = {"n": len(items)}
    for n in names:
        got = [scores.get(i["item_id"], {}).get(n, {"score": None, "result": "error"}) for i in items]
        vals = [g["score"] for g in got if g["score"] is not None]
        out[n] = {"scored": len(vals), "errors": len(got) - len(vals),
                  "mean": round(sum(vals) / len(vals), 2) if vals else None,
                  "pass": sum(g["result"] == "pass" for g in got), "fail": sum(g["result"] == "fail" for g in got),
                  "scores": {str(s): sum(v == s for v in vals) for s in sorted(set(vals))}}
    return out


def summarise(items: list[dict], scores: dict, names: list[str]) -> dict:
    aired = [i for i in items if i["set"] == "aired"]
    drafts = [i for i in items if i["set"] == "first_draft"]
    aired_of = {(i["decision_id"], i["kind"]): i for i in aired}

    def group(rows, key, order):
        keys = [k for k in order if any(r[key] == k for r in rows)] + sorted({r[key] for r in rows} - set(order))
        return {k: tally([r for r in rows if r[key] == k], scores, names) for k in keys}

    pairs = []
    for d in drafts:
        a = aired_of.get((d["decision_id"], d["kind"]))
        g = lambda i: scores.get(i["item_id"], {}).get("groundedness") if i else None  # noqa: E731
        pairs.append({"decision_id": d["decision_id"], "kind": d["kind"], "truth": d["truth"], "planted": d["planted"],
                      "referee_flags": d["referee_flags"], "hand_check": d["hand_check"],
                      "first_draft": d["response"], "first_draft_groundedness": g(d),
                      "aired": a["response"] if a else None, "aired_groundedness": g(a)})
    return {
        "aired": {
            "all": tally(aired, scores, names),
            "by_kind": group(aired, "kind", KINDS),
            "by_kind_and_bucket": {k: group([r for r in aired if r["kind"] == k], "bucket",
                                            CAPTION_BUCKETS if k == "caption" else LINE_BUCKETS)
                                   for k in KINDS if any(r["kind"] == k for r in aired)},
        },
        "first_drafts": {
            "about": ("First drafts the code referee did not pass, with what is known about them. "
                      "planted_error: the red team told the writer to include it. own_error: a false detail the "
                      "narrator wrote unasked, confirmed by hand. true_detail_flagged: checked by hand, nothing false "
                      "(the referee's flag was a false alarm). unreviewed: no hand check. groundedness 'fail' = the "
                      "Foundry evaluator also found the draft not backed by the facts."),
            "by_truth": group(drafts, "truth", TRUTHS),
            "by_kind_and_truth": {k: group([r for r in drafts if r["kind"] == k], "truth", TRUTHS)
                                  for k in KINDS if any(r["kind"] == k for r in drafts)},
            "pairs": pairs,
        },
    }


def describe_inputs(items: list[dict]) -> str:
    aired = [i for i in items if i["set"] == "aired"]
    drafts = [i for i in items if i["set"] == "first_draft"]
    parts = [f"{sum(i['kind'] == k for i in aired)} {k}" for k in KINDS]
    truths = [f"{sum(i['truth'] == t for i in drafts)} {t}" for t in TRUTHS if any(i["truth"] == t for i in drafts)]
    return f"{len(aired)} aired ({', '.join(parts)}); {len(drafts)} first drafts stopped ({', '.join(truths) or 'none'})"


def default_out(trace_path: str) -> Path:
    return Path("public/traces/eval") / f"foundry-evaluators.{Path(trace_path).stem}.json"


async def build_from_trace(trace: dict, adjudication: str | None) -> tuple[list[dict], list[str]]:
    from captionvar_agents.factbox import Factbox

    async with Factbox(seed=trace["settings"]["match_seed"]) as factbox:
        contexts = await gather_contexts(trace, factbox)
    return build_items(trace, contexts, load_adjudication(adjudication, trace)), contexts["mismatches"]


def main(args: argparse.Namespace) -> int:
    names = [n.strip() for n in args.evaluators.split(",") if n.strip()]
    unknown = [n for n in names if n not in EVALUATORS]
    if unknown or not names:
        raise SystemExit(f"unknown evaluator(s) {', '.join(unknown)}; choose from {', '.join(EVALUATORS)}")
    trace = json.loads(Path(args.trace).read_text(encoding="utf-8"))
    out = Path(args.out) if args.out else default_out(args.trace)
    inputs_path = Path(args.inputs) if args.inputs else out.with_name(out.stem + ".inputs.jsonl")

    items, mismatches = asyncio.run(build_from_trace(trace, args.adjudication))
    if mismatches:
        print(f"warning: {len(mismatches)} decision(s) do not match the moments rebuilt from the seed and are skipped: "
              f"{', '.join(mismatches)}")
    if args.limit:
        items = items[: args.limit]
    write_jsonl(items, inputs_path)
    print(f"{trace['match_id']} ({Path(args.trace).name}): {describe_inputs(items)}")
    print(f"wrote {len(items)} evaluator inputs to {inputs_path}")
    if args.dry_run:
        print(f"dry run: no Azure calls. Evaluators that would run: {', '.join(names)} "
              f"({len(items) * len(names)} model calls).")
        return 0

    env = dict(os.environ)
    config = model_config(env)
    if args.log_to_foundry and not env.get("FOUNDRY_PROJECT_ENDPOINT"):
        raise SystemExit("--log-to-foundry needs FOUNDRY_PROJECT_ENDPOINT.")
    from azure.identity import DefaultAzureCredential

    credential = DefaultAzureCredential()
    evaluators = make_evaluators(names, config, AzureOpenAICredential(credential))
    print(f"scoring with {', '.join(names)} on deployment {config['azure_deployment']} at {config['azure_endpoint']} "
          f"({len(items) * len(names)} model calls, {args.workers} at a time)")
    started = time.time()
    result = run_evaluate(inputs_path, evaluators, args.workers)
    scores = scores_from_rows(result["rows"], names)
    errors = sum(s[n]["result"] == "error" for s in scores.values() for n in names)

    report = {
        "version": "1.0",
        "what_is_measured": MEASURED,
        "trace": {"file": Path(args.trace).name, "match_id": trace["match_id"], "model": trace.get("model"),
                  "generated_at": trace.get("generated_at")},
        "evaluators": {n: {"class": f"azure.ai.evaluation.{EVALUATORS[n][0]}", "inputs": list(EVALUATORS[n][1]),
                           "scale": "1-5", "threshold": THRESHOLD} for n in names},
        "judge": {"package": f"{PACKAGE}=={PACKAGE_VERSION}", "deployment": config["azure_deployment"],
                  "endpoint_host": urlparse(config["azure_endpoint"]).hostname},
        "context": ("The facts the agent that wrote the text was given, rebuilt from the match seed by the factbox: "
                    "the narrator's moment facts and recent play for captions, the Analyst's running numbers for "
                    "lines, the recap facts for recap sentences. Squad lists left out."),
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "wall_seconds": round(time.time() - started, 1),
        "limit": args.limit,
        "evaluator_errors": errors,
        "sdk_metrics": {k: number(v) for k, v in (result.get("metrics") or {}).items()},
        "foundry_portal_url": None,
        **summarise(items, scores, names),
        "items": [{**{k: v for k, v in i.items() if k not in ("context", "query")}, "scores": scores.get(i["item_id"], {})}
                  for i in items],
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {out}")

    if args.log_to_foundry:
        try:
            url = log_to_foundry(result, evaluators, env["FOUNDRY_PROJECT_ENDPOINT"],
                                 f"CaptionVAR {Path(args.trace).stem}", credential)
            report["foundry_portal_url"] = url
            out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"uploaded to the Foundry project: {url or '(no URL returned)'}")
        except Exception as exc:  # noqa: BLE001 - the local results are already saved
            print(f"upload to the Foundry project failed; the local results are kept. {type(exc).__name__}: {exc}")

    print_summary(report, names)
    if errors:
        print(f"\n{errors} evaluator call(s) failed (no score). Check the sign-in and deployment, then run again.")
        return 1
    return 0


def print_summary(report: dict, names: list[str]) -> None:
    def cells(t):
        return "  ".join(f"{n} {t[n]['pass']}/{t['n']} pass (mean {t[n]['mean']})" for n in names)

    print("\naired")
    for kind, buckets in report["aired"]["by_kind_and_bucket"].items():
        for bucket, t in buckets.items():
            print(f"  {kind:<15} {bucket:<24} {cells(t)}")
    if "groundedness" in names and report["first_drafts"]["by_truth"]:
        print("\nfirst drafts the referee stopped: groundedness fail = the evaluator also caught it")
        for truth, t in report["first_drafts"]["by_truth"].items():
            g = t["groundedness"]
            print(f"  {truth:<20} {g['fail']}/{t['n']} fail")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--trace", default="public/traces/foundry-demo.json")
    ap.add_argument("--out", help="results JSON (default public/traces/eval/foundry-evaluators.<trace>.json)")
    ap.add_argument("--inputs", help="evaluator inputs JSONL (default: next to --out, .inputs.jsonl)")
    ap.add_argument("--adjudication", default="docs/demo-adjudication.json",
                    help="hand checks; used only if made on the same run (generated_at)")
    ap.add_argument("--evaluators", default=",".join(DEFAULT_EVALUATORS))
    ap.add_argument("--limit", type=int)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--log-to-foundry", action="store_true")
    sys.exit(main(ap.parse_args()))
