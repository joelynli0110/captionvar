#!/usr/bin/env bash
# Deploy CaptionVAR live mode to Azure Container Apps (bash twin of infra/deploy.ps1; see docs/LIVE.md).
#
#   az login
#   SUBSCRIPTION_ID=<id> FOUNDRY_PROJECT_ENDPOINT=https://<resource>.services.ai.azure.com/api/projects/<project> \
#   FOUNDRY_MODEL=gpt-4.1-mini ./infra/deploy.sh
#
# Optional: FOUNDRY_RESOURCE_ID, RESOURCE_GROUP, LOCATION, APP_NAME, ENVIRONMENT_NAME, ACR_NAME,
# MIN_REPLICAS (1), APPINSIGHTS_CONNECTION_STRING, ROLE_NAME, LIVE_ENABLED (1), LOCAL_BUILD=1,
# MAX_CALLS_PER_RUN (60), DAILY_RUNS (20), DAILY_CALLS (800).
set -euo pipefail

: "${SUBSCRIPTION_ID:?set SUBSCRIPTION_ID}"
: "${FOUNDRY_PROJECT_ENDPOINT:?set FOUNDRY_PROJECT_ENDPOINT}"
FOUNDRY_MODEL="${FOUNDRY_MODEL:-gpt-4.1-mini}"
RESOURCE_GROUP="${RESOURCE_GROUP:-rg-captionvar-live}"
LOCATION="${LOCATION:-westeurope}"
APP_NAME="${APP_NAME:-captionvar-live}"
ENVIRONMENT_NAME="${ENVIRONMENT_NAME:-captionvar-live-env}"
MIN_REPLICAS="${MIN_REPLICAS:-1}"
LIVE_ENABLED="${LIVE_ENABLED:-1}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

step() { printf '\n== %s\n' "$*"; }
try() { "$@" 2>/dev/null || true; }

ensure_role() {  # principal, role, scope
  if [ -n "$(try az role assignment list --assignee "$1" --role "$2" --scope "$3" --query '[0].id' -o tsv)" ]; then
    echo "  '$2' already assigned"; return 1
  fi
  for i in 1 2 3 4 5 6; do
    if az role assignment create --assignee-object-id "$1" --assignee-principal-type ServicePrincipal \
         --role "$2" --scope "$3" --only-show-errors -o none; then
      echo "  assigned '$2'"; return 0
    fi
    echo "  waiting for the identity to propagate ($i/6)..."; sleep 15
  done
  echo "Could not assign '$2' on $3 (you need Owner or User Access Administrator there)" >&2; exit 1
}

step "Checking the Azure CLI and subscription"
command -v az >/dev/null || { echo "Install the Azure CLI first" >&2; exit 1; }
az account set --subscription "$SUBSCRIPTION_ID"
[ "$(az account show --query id -o tsv)" = "$SUBSCRIPTION_ID" ] || { echo "az is not on $SUBSCRIPTION_ID" >&2; exit 1; }
echo "  subscription: $(az account show --query name -o tsv) ($SUBSCRIPTION_ID) as $(az account show --query user.name -o tsv)"

FOUNDRY_PROJECT_ENDPOINT="${FOUNDRY_PROJECT_ENDPOINT%/}"
if [[ ! "$FOUNDRY_PROJECT_ENDPOINT" =~ ^https://([^./]+)\.services\.ai\.azure\.com/api/projects/[^/]+$ ]]; then
  echo "FOUNDRY_PROJECT_ENDPOINT should look like https://<resource>.services.ai.azure.com/api/projects/<project>" >&2; exit 1
fi
FOUNDRY_NAME="${BASH_REMATCH[1]}"
FOUNDRY_RESOURCE_ID="${FOUNDRY_RESOURCE_ID:-$(try az resource list --resource-type Microsoft.CognitiveServices/accounts --name "$FOUNDRY_NAME" --query '[0].id' -o tsv)}"
[ -n "$FOUNDRY_RESOURCE_ID" ] || { echo "Foundry resource '$FOUNDRY_NAME' not found; set FOUNDRY_RESOURCE_ID" >&2; exit 1; }
echo "  Foundry resource: $FOUNDRY_RESOURCE_ID"
if [ -z "${ROLE_NAME:-}" ]; then
  for candidate in "Foundry User" "Azure AI User"; do
    if [ -n "$(try az role definition list --name "$candidate" --query '[0].name' -o tsv)" ]; then ROLE_NAME="$candidate"; break; fi
  done
fi
[ -n "${ROLE_NAME:-}" ] || { echo "Neither 'Foundry User' nor 'Azure AI User' found; set ROLE_NAME" >&2; exit 1; }
echo "  role for the app's identity on Foundry: $ROLE_NAME"
ACR_NAME="${ACR_NAME:-captionvar$(printf '%s' "$SUBSCRIPTION_ID" | sha256sum | cut -c1-8)}"

step "Preparing the subscription"
az extension add --name containerapp --upgrade --only-show-errors -o none
for ns in Microsoft.App Microsoft.OperationalInsights Microsoft.ContainerRegistry; do
  [ "$(try az provider show --namespace "$ns" --query registrationState -o tsv)" = "Registered" ] || az provider register --namespace "$ns" --wait -o none
done

step "Resource group $RESOURCE_GROUP ($LOCATION)"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" -o none

step "Container registry $ACR_NAME"
[ -n "$(try az acr show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" --query id -o tsv)" ] ||
  az acr create --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" --location "$LOCATION" --sku Basic --admin-enabled false -o none
ACR_ID="$(az acr show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" --query id -o tsv)"
ACR_SERVER="$(az acr show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" --query loginServer -o tsv)"

TAG="$(date -u +%Y%m%d-%H%M%S)"
SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || true)"
[ -z "$SHA" ] || TAG="$TAG-$SHA"
IMAGE="$ACR_SERVER/captionvar-live:$TAG"
if [ "${LOCAL_BUILD:-0}" = "1" ]; then
  step "Building the image with local Docker and pushing it"
  az acr login --name "$ACR_NAME"
  docker build --platform linux/amd64 -t "$IMAGE" "$REPO_ROOT"
  docker push "$IMAGE"
else
  step "Building the image in Azure (az acr build, about 5 minutes)"
  az acr build --registry "$ACR_NAME" --resource-group "$RESOURCE_GROUP" --image "captionvar-live:$TAG" \
    --platform linux/amd64 --file "$REPO_ROOT/Dockerfile" "$REPO_ROOT" ||
    { echo "az acr build failed; if ACR Tasks are not allowed on this subscription, rerun with LOCAL_BUILD=1" >&2; exit 1; }
fi
echo "  image: $IMAGE"

step "Container Apps environment $ENVIRONMENT_NAME"
[ -n "$(try az containerapp env show --name "$ENVIRONMENT_NAME" --resource-group "$RESOURCE_GROUP" --query id -o tsv)" ] ||
  az containerapp env create --name "$ENVIRONMENT_NAME" --resource-group "$RESOURCE_GROUP" --location "$LOCATION" -o none

step "Container app $APP_NAME"
if [ -z "$(try az containerapp show --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --query id -o tsv)" ]; then
  # Placeholder image and no ingress first, so the identity can get AcrPull before our image is pulled.
  az containerapp create --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --environment "$ENVIRONMENT_NAME" \
    --image mcr.microsoft.com/k8se/quickstart:latest --system-assigned --min-replicas 0 --max-replicas 1 -o none
fi
PRINCIPAL_ID="$(try az containerapp show --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --query identity.principalId -o tsv)"
if [ -z "$PRINCIPAL_ID" ]; then
  az containerapp identity assign --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --system-assigned -o none
  PRINCIPAL_ID="$(az containerapp show --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --query identity.principalId -o tsv)"
fi
echo "  managed identity: $PRINCIPAL_ID"

step "Roles for the managed identity"
NEW=0
ensure_role "$PRINCIPAL_ID" AcrPull "$ACR_ID" && NEW=1
ensure_role "$PRINCIPAL_ID" "$ROLE_NAME" "$FOUNDRY_RESOURCE_ID" && NEW=1
[ "$NEW" = 0 ] || { echo "  waiting 60 s for the new roles to take effect"; sleep 60; }
az containerapp registry set --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --server "$ACR_SERVER" --identity system -o none

ENV_VARS=("FOUNDRY_PROJECT_ENDPOINT=$FOUNDRY_PROJECT_ENDPOINT" "FOUNDRY_MODEL=$FOUNDRY_MODEL" "LIVE_ENABLED=$LIVE_ENABLED"
  "LIVE_MAX_CALLS=${MAX_CALLS_PER_RUN:-60}" "LIVE_DAILY_RUNS=${DAILY_RUNS:-20}" "LIVE_DAILY_CALLS=${DAILY_CALLS:-800}" "PORT=8000")
if [ -n "${APPINSIGHTS_CONNECTION_STRING:-}" ]; then
  az containerapp secret set --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --secrets "appinsights=$APPINSIGHTS_CONNECTION_STRING" -o none
  ENV_VARS+=("APPLICATIONINSIGHTS_CONNECTION_STRING=secretref:appinsights")
fi

step "Deploying the image"
for i in 1 2 3; do
  if az containerapp update --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --image "$IMAGE" \
       --cpu 0.5 --memory 1.0Gi --min-replicas "$MIN_REPLICAS" --max-replicas 1 --set-env-vars "${ENV_VARS[@]}" -o none; then
    break
  fi
  [ "$i" = 3 ] && { echo "az containerapp update failed; logs: az containerapp logs show -n $APP_NAME -g $RESOURCE_GROUP" >&2; exit 1; }
  echo "  retrying in 30 s (roles may still be propagating)"; sleep 30
done
az containerapp ingress enable --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --type external --target-port 8000 --transport auto -o none

FQDN="$(az containerapp show --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --query properties.configuration.ingress.fqdn -o tsv)"
URL="https://$FQDN/captionvar/"
step "Checking $URL"
for i in $(seq 1 20); do
  if curl -fsS --max-time 20 "https://$FQDN/healthz" >/dev/null 2>&1; then
    echo "  $(curl -fsS --max-time 20 "https://$FQDN/captionvar/api/live/status")"; break
  fi
  [ "$i" = 20 ] && echo "  the app did not answer yet; logs: az containerapp logs show -n $APP_NAME -g $RESOURCE_GROUP --follow"
  sleep 10
done

printf '\nCaptionVAR live:  %s\nStart a live run:  %s?live=1\n' "$URL" "$URL"
echo "Switch live runs off (replay stays up): az containerapp update -n $APP_NAME -g $RESOURCE_GROUP --set-env-vars LIVE_ENABLED=0"
echo "Delete everything: az group delete -n $RESOURCE_GROUP --yes --no-wait"
