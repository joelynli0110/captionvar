# Live mode on Azure Container Apps

Live on Azure Container Apps: <URL added after deploy>

The demo on GitHub Pages replays a recorded Foundry run. Live mode runs the same agents on Microsoft Foundry while you watch: one container serves the site, runs the Agent Framework workflow and the referee MCP server, and streams each decision to the page as it is made.

- **What runs.** Four moments of the demo match from 24' (the goal, a sprint, a possession report, a chance), with the lines on why they matter. With the default seed the red team plants a wrong score in the goal caption, as in the recorded run, and two more errors. Offline the run makes 30 model calls; on Foundry it is usually fewer, and never more than the cap of 60.
- **What you see.** The page shows **LIVE · Microsoft Foundry · \<model\>** above the pitch. The match clock waits just after each moment until its caption has been through the check. **Back to the replay** returns to the recorded run. On GitHub Pages none of this appears.
- **No keys.** The app signs in to Foundry with its system-assigned managed identity. Nothing secret is in the repository or the image.

```text
browser ── GET /captionvar/ ───────────────► live_server.py (Starlette) ── serves dist/
        ── POST /captionvar/api/live/start ─►   one run at a time ── run_moment() per moment (pipeline.py)
        ◄─ SSE /captionvar/api/live/stream ─    start, decision × 4, end        │
                                                                                ├─► Foundry project (managed identity)
                                                                                └─► node scripts/referee-mcp.mjs (MCP, stdio)
```

## Run it locally

Offline, with the scripted model (no Azure, no cost):

```powershell
npm ci; npm run build
python -m venv .venv; .\.venv\Scripts\Activate.ps1
pip install -r agents\requirements.txt
python agents\live_server.py --offline      # http://127.0.0.1:8000/captionvar/
```

On Foundry, with your own `az login`:

```powershell
$env:FOUNDRY_PROJECT_ENDPOINT = "https://<resource>.services.ai.azure.com/api/projects/<project>"
$env:FOUNDRY_MODEL = "gpt-4.1-mini"
python agents\live_server.py
```

Open the page and click **Run it live**, or open `/captionvar/?live=1`. `pytest agents/tests` includes an end-to-end test of the server: it starts it with the scripted model, reads the stream and checks the decisions against `run_match.py`.

## Deploy

You need the Azure CLI, `az login` to the subscription you want to use, and **Owner** (or Contributor plus User Access Administrator) on that subscription and on the Foundry resource, because the script assigns roles. No local Docker is needed: the image is built in Azure.

```powershell
az login
az account list -o table          # find your subscription ID
.\infra\deploy.ps1 `
  -SubscriptionId "<your subscription ID>" `
  -FoundryProjectEndpoint "https://<resource>.services.ai.azure.com/api/projects/<project>" `
  -FoundryModel "gpt-4.1-mini"
```

It takes about 10 minutes the first time (5 for the image build) and prints the URL at the end. Running it again builds a new image and updates the app; existing resources are reused.

| Parameter | Default | |
|---|---|---|
| `-SubscriptionId` | (required) | The script stops if `az` is on another subscription. |
| `-FoundryProjectEndpoint` | (required) | Foundry portal → your project → Overview → Project endpoint. |
| `-FoundryModel` | `gpt-4.1-mini` | Your model deployment's name. |
| `-FoundryResourceId` | found from the endpoint | `/subscriptions/…/providers/Microsoft.CognitiveServices/accounts/<resource>`. Pass it if the Foundry resource is in another subscription. |
| `-ResourceGroup`, `-Location`, `-AppName` | `rg-captionvar-live`, `westeurope`, `captionvar-live` | |
| `-MinReplicas` | `1` | 1 keeps a replica warm (no cold start while judges look). 0 scales to zero; the first visit then waits for the container to start. |
| `-AppInsightsConnectionString` | none | Sends traces of live runs to that Application Insights resource (stored as a Container Apps secret). |
| `-LocalBuild` | off | Builds with local Docker and pushes, for subscriptions where ACR Tasks (`az acr build`) are not allowed, such as some free-trial or credit subscriptions. |
| `-MaxCallsPerRun`, `-DailyRuns`, `-DailyCalls` | `60`, `20`, `800` | Cost guards, below. |

The bash twin takes the same inputs as environment variables: `SUBSCRIPTION_ID=… FOUNDRY_PROJECT_ENDPOINT=… ./infra/deploy.sh`.

What it creates: a resource group, a Basic container registry (admin user off), a Container Apps environment with its Log Analytics workspace, and the container app (0.5 vCPU, 1 GiB, max 1 replica) with a system-assigned managed identity.

**Which role.** The app's identity gets **Foundry User** on the Foundry resource; in tenants where the old name is still used, it is **Azure AI User** (the script picks whichever exists, or pass `-RoleName`). Microsoft's [Foundry RBAC guidance](https://learn.microsoft.com/azure/foundry/concepts/rbac-foundry) gives it as the least-privilege role for building with and calling a project, and advises against the built-in roles that start with *Cognitive Services* (such as Cognitive Services OpenAI User) for Foundry projects. The workflow calls the project endpoint, so it is Foundry User. The identity also gets **AcrPull** on the registry, so the image is pulled without registry passwords. New role assignments can take a few minutes to apply; the script waits and retries.

## Cost guards

| Setting | Default | |
|---|---|---|
| `LIVE_ENABLED` | `1` | `0` turns live runs off. The site and the replay stay up. |
| One run at a time | | Anyone who asks while a run is going watches the same run. |
| `LIVE_MAX_CALLS` | `60` | Hard cap on model calls per run, retries included. The run stops at the cap. |
| `LIVE_DAILY_RUNS`, `LIVE_DAILY_CALLS` | `20`, `800` | Per UTC day. After that the page shows the replay with a note. |
| `LIVE_CACHE_MINUTES` | `10` | A finished run is shown again, without new calls, for this long. |
| `LIVE_RPM` | `30` | Requests per minute to the deployment. |
| `LIVE_FROM_MINUTE`, `LIVE_MOMENTS` | `24`, `4` | The window of the match that runs live. |

The daily counters are kept in memory, so a restart resets them; that is why the app is limited to one replica. Change a setting with `az containerapp update -n captionvar-live -g rg-captionvar-live --set-env-vars LIVE_DAILY_RUNS=10`.

## What it costs

Estimates at list prices; check the [Container Apps](https://azure.microsoft.com/pricing/details/container-apps/) and [Azure OpenAI](https://azure.microsoft.com/pricing/details/cognitive-services/openai-service/) pricing pages for your region.

- **Model.** The recorded run cost about $0.18 for 188 calls with gpt-4.1-mini, so about $0.001 a call: a live run is a few cents. The daily cap of 800 calls bounds it at roughly $1 a day.
- **Container app, one replica always on.** Billed per second, at the lower idle rate when it is not serving. Roughly $0.35 a day idle, up to about $1.10 a day if busy all day, before the monthly free grant (180,000 vCPU-seconds and 360,000 GiB-seconds per subscription). With `-MinReplicas 0` it costs nothing while unused.
- **Container registry, Basic.** About $0.17 a day.
- **Log Analytics.** Pay per GB of logs; a few MB a day here.

## Switch it off after judging (after 10 November)

Live runs off, site up (no model cost):

```powershell
az containerapp update -n captionvar-live -g rg-captionvar-live --set-env-vars LIVE_ENABLED=0
```

Scale to zero (no container cost while unused):

```powershell
az containerapp update -n captionvar-live -g rg-captionvar-live --min-replicas 0
```

Delete everything (stops all cost, including the registry):

```powershell
az group delete -n rg-captionvar-live --yes --no-wait
```

The role assignment on the Foundry resource goes with the app's identity; `az role assignment list --scope <Foundry resource ID> -o table` shows any left over.

## Limits

- **A live run is not checked by hand.** The recorded run's own-error tags come from a hand check of that run (`docs/demo-adjudication.json`); a live run has none.
- **Four moments, no recaps.** The recaps need the whole half, which is too long for a live demo.
- **Times include the wait.** The replay airs each caption at its recorded time to air. Live, the clock also waits for the model, so a slow call shows as a pause.
- **One replica.** Live runs and their counters live in that replica's memory.
