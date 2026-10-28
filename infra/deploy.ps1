<#
.SYNOPSIS
  Deploy CaptionVAR live mode to Azure Container Apps (no keys: managed identity).

.DESCRIPTION
  Creates or updates, in the subscription you name:
    - a resource group
    - an Azure Container Registry (Basic); the image is built in Azure (az acr build), no local Docker
    - a Container Apps environment (with its Log Analytics workspace)
    - the container app, with a system-assigned managed identity that can
        pull from the registry (AcrPull) and call the Foundry project
        ("Foundry User", formerly "Azure AI User", on the Foundry resource)
  Safe to run again: existing resources are reused, and the app gets the new image.
  See docs/LIVE.md.

.EXAMPLE
  az login
  .\infra\deploy.ps1 -SubscriptionId <id> `
      -FoundryProjectEndpoint "https://<resource>.services.ai.azure.com/api/projects/<project>" `
      -FoundryModel gpt-4.1-mini
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $SubscriptionId,
  [Parameter(Mandatory = $true)] [string] $FoundryProjectEndpoint,
  [string] $FoundryModel = "gpt-4.1-mini",
  # /subscriptions/.../providers/Microsoft.CognitiveServices/accounts/<name>; found from the endpoint if left out.
  [string] $FoundryResourceId = "",
  [string] $ResourceGroup = "rg-captionvar-live",
  [string] $Location = "westeurope",
  [string] $AppName = "captionvar-live",
  [string] $EnvironmentName = "captionvar-live-env",
  # Globally unique, letters and digits only; derived from the subscription if left out.
  [string] $AcrName = "",
  # 1 keeps one replica warm during judging (no cold start); 0 scales to zero when unused.
  [ValidateRange(0, 1)] [int] $MinReplicas = 1,
  # Optional: send traces of the live runs to this Application Insights resource.
  [string] $AppInsightsConnectionString = "",
  # Leave empty to use "Foundry User", or "Azure AI User" where the old name is still used.
  [string] $RoleName = "",
  [ValidateSet("0", "1")] [string] $LiveEnabled = "1",
  # Build with local Docker and push, instead of az acr build (ACR Tasks are not
  # available on some free-trial or credit subscriptions).
  [switch] $LocalBuild,
  [int] $MaxCallsPerRun = 60,
  [int] $DailyRuns = 20,
  [int] $DailyCalls = 800
)

$ErrorActionPreference = "Stop"
# az is Python: keep its output UTF-8 on Windows (az acr build streams the build log).
$env:PYTHONIOENCODING = "utf-8"
$RepoRoot = Split-Path -Parent $PSScriptRoot

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }

# Run az, stop on failure, return its output (trimmed text). Native stderr
# (az warnings) must not count as an error in Windows PowerShell 5.1, hence Continue.
function AzRun {
  $ErrorActionPreference = "Continue"
  $out = & az @args
  if ($LASTEXITCODE -ne 0) { throw "az $($args -join ' ') failed (exit $LASTEXITCODE)" }
  if ($null -eq $out) { return "" }
  return ($out | Out-String).Trim()
}

# Run az and return its output, or "" if it fails (for "does it exist?" checks).
function AzTry {
  $ErrorActionPreference = "Continue"
  $out = & az @args 2>$null
  if ($LASTEXITCODE -ne 0 -or $null -eq $out) { return "" }
  return ($out | Out-String).Trim()
}

function Ensure-Role($principalId, $role, $scope) {
  $ErrorActionPreference = "Continue"
  $have = AzTry role assignment list --assignee $principalId --role $role --scope $scope --query "[0].id" -o tsv
  if ($have) { Write-Host "  '$role' already assigned"; return $false }
  # The identity can take a moment to appear in Entra ID; retry.
  for ($i = 1; $i -le 6; $i++) {
    & az role assignment create --assignee-object-id $principalId --assignee-principal-type ServicePrincipal `
      --role $role --scope $scope --only-show-errors -o none
    if ($LASTEXITCODE -eq 0) { Write-Host "  assigned '$role'"; return $true }
    Write-Host "  waiting for the identity to propagate ($i/6)..."
    Start-Sleep -Seconds 15
  }
  throw "Could not assign '$role' on $scope. You need Owner or User Access Administrator there."
}

# ---------------------------------------------------------------- checks

Step "Checking the Azure CLI and subscription"
if (-not (Get-Command az -ErrorAction SilentlyContinue)) { throw "Install the Azure CLI first: https://aka.ms/installazurecli" }
AzRun account set --subscription $SubscriptionId | Out-Null
$accountId = AzRun account show --query id -o tsv
if ($accountId -ne $SubscriptionId) { throw "az is on subscription $accountId, not $SubscriptionId" }
Write-Host "  subscription: $(AzRun account show --query name -o tsv) ($accountId) as $(AzRun account show --query user.name -o tsv)"

if ($FoundryProjectEndpoint -notmatch '^https://([^./]+)\.services\.ai\.azure\.com/api/projects/[^/]+/?$') {
  throw "FoundryProjectEndpoint should look like https://<resource>.services.ai.azure.com/api/projects/<project>"
}
$foundryName = $Matches[1]
$FoundryProjectEndpoint = $FoundryProjectEndpoint.TrimEnd('/')

if (-not $FoundryResourceId) {
  $FoundryResourceId = AzTry resource list --resource-type Microsoft.CognitiveServices/accounts --name $foundryName --query "[0].id" -o tsv
  if (-not $FoundryResourceId) {
    throw "Foundry resource '$foundryName' not found in this subscription. Pass -FoundryResourceId (Foundry portal or Azure portal > the resource > JSON view > Resource ID)."
  }
}
Write-Host "  Foundry resource: $FoundryResourceId"

if (-not $RoleName) {
  foreach ($candidate in @("Foundry User", "Azure AI User")) {
    if (AzTry role definition list --name $candidate --query "[0].name" -o tsv) { $RoleName = $candidate; break }
  }
  if (-not $RoleName) { throw "Neither 'Foundry User' nor 'Azure AI User' role found; pass -RoleName." }
}
Write-Host "  role for the app's identity on Foundry: $RoleName"

if (-not $AcrName) {
  $hash = [System.BitConverter]::ToString(
    [System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($SubscriptionId))
  ).Replace("-", "").Substring(0, 8).ToLower()
  $AcrName = "captionvar$hash"
}

Step "Preparing the subscription"
AzRun extension add --name containerapp --upgrade --only-show-errors -o none | Out-Null
foreach ($ns in @("Microsoft.App", "Microsoft.OperationalInsights", "Microsoft.ContainerRegistry")) {
  $state = AzTry provider show --namespace $ns --query registrationState -o tsv
  if ($state -ne "Registered") {
    Write-Host "  registering $ns (one-off, can take a few minutes)"
    AzRun provider register --namespace $ns --wait -o none | Out-Null
  }
}

# ---------------------------------------------------------------- resources

Step "Resource group $ResourceGroup ($Location)"
if ((az group exists --name $ResourceGroup).Trim() -ne "true") {
    AzRun group create --name $ResourceGroup --location $Location -o none | Out-Null
}

Step "Container registry $AcrName"
if (-not (AzTry acr show --name $AcrName --resource-group $ResourceGroup --query id -o tsv)) {
  AzRun acr create --name $AcrName --resource-group $ResourceGroup --location $Location --sku Basic --admin-enabled false -o none | Out-Null
}
$acrId = AzRun acr show --name $AcrName --resource-group $ResourceGroup --query id -o tsv
$acrServer = AzRun acr show --name $AcrName --resource-group $ResourceGroup --query loginServer -o tsv

Step $(if ($LocalBuild) { "Building the image with local Docker and pushing it" } else { "Building the image in Azure (az acr build, about 5 minutes)" })
$tag = (Get-Date -Format "yyyyMMdd-HHmmss")
$sha = & { $ErrorActionPreference = "Continue"; & git -C $RepoRoot rev-parse --short HEAD 2>$null }
if ($LASTEXITCODE -eq 0 -and $sha) { $tag = "$tag-$sha" }
$image = "$acrServer/captionvar-live:$tag"
if ($LocalBuild) {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw "-LocalBuild needs Docker Desktop running." }
  AzRun acr login --name $AcrName | Out-Null   # a short-lived token from your az login; no admin keys
  & { $ErrorActionPreference = "Continue"; docker build --platform linux/amd64 -t $image $RepoRoot }
  if ($LASTEXITCODE -ne 0) { throw "docker build failed" }
  & { $ErrorActionPreference = "Continue"; docker push $image }
  if ($LASTEXITCODE -ne 0) { throw "docker push failed" }
} else {
  # Uploads the repository (minus .dockerignore) and builds it in Azure; the log streams here.
  & { $ErrorActionPreference = "Continue"; az acr build --registry $AcrName --resource-group $ResourceGroup --image "captionvar-live:$tag" --platform linux/amd64 --file (Join-Path $RepoRoot "Dockerfile") $RepoRoot }
  if ($LASTEXITCODE -ne 0) { throw "az acr build failed. If ACR Tasks are not allowed on this subscription, run again with -LocalBuild (needs Docker Desktop)." }
}
if (-not (AzTry acr repository show --name $AcrName --image "captionvar-live:$tag" --query digest -o tsv)) { throw "Image $image not found after the build." }
Write-Host "  image: $image"

Step "Container Apps environment $EnvironmentName"
if (-not (AzTry containerapp env show --name $EnvironmentName --resource-group $ResourceGroup --query id -o tsv)) {
  AzRun containerapp env create --name $EnvironmentName --resource-group $ResourceGroup --location $Location -o none | Out-Null
}

Step "Container app $AppName"
if (-not (AzTry containerapp show --name $AppName --resource-group $ResourceGroup --query id -o tsv)) {
  # Created with a public placeholder image and no ingress first, so the identity
  # exists (and can be given AcrPull) before the app pulls our image. Ingress on
  # port 8000 is turned on once our image runs.
  AzRun containerapp create --name $AppName --resource-group $ResourceGroup --environment $EnvironmentName `
    --image mcr.microsoft.com/k8se/quickstart:latest --system-assigned --min-replicas 0 --max-replicas 1 -o none | Out-Null
}
$principalId = AzTry containerapp show --name $AppName --resource-group $ResourceGroup --query identity.principalId -o tsv
if (-not $principalId) {
  AzRun containerapp identity assign --name $AppName --resource-group $ResourceGroup --system-assigned -o none | Out-Null
  $principalId = AzRun containerapp show --name $AppName --resource-group $ResourceGroup --query identity.principalId -o tsv
}
Write-Host "  managed identity: $principalId"

Step "Roles for the managed identity"
$new = Ensure-Role $principalId "AcrPull" $acrId
$new = (Ensure-Role $principalId $RoleName $FoundryResourceId) -or $new
if ($new) { Write-Host "  waiting 60 s for the new roles to take effect"; Start-Sleep -Seconds 60 }

AzRun containerapp registry set --name $AppName --resource-group $ResourceGroup --server $acrServer --identity system -o none | Out-Null

$envVars = @(
  "FOUNDRY_PROJECT_ENDPOINT=$FoundryProjectEndpoint",
  "FOUNDRY_MODEL=$FoundryModel",
  "LIVE_ENABLED=$LiveEnabled",
  "LIVE_MAX_CALLS=$MaxCallsPerRun",
  "LIVE_DAILY_RUNS=$DailyRuns",
  "LIVE_DAILY_CALLS=$DailyCalls",
  "PORT=8000"
)
if ($AppInsightsConnectionString) {
  AzRun containerapp secret set --name $AppName --resource-group $ResourceGroup --secrets "appinsights=$AppInsightsConnectionString" -o none | Out-Null
  $envVars += "APPLICATIONINSIGHTS_CONNECTION_STRING=secretref:appinsights"
}

Step "Deploying the image"
$ok = $false
$ErrorActionPreference = "Continue"
for ($i = 1; $i -le 3 -and -not $ok; $i++) {
  & az containerapp update --name $AppName --resource-group $ResourceGroup --image $image `
    --cpu 0.5 --memory 1.0Gi --min-replicas $MinReplicas --max-replicas 1 `
    --set-env-vars @envVars -o none
  if ($LASTEXITCODE -eq 0) { $ok = $true } else { Write-Host "  retrying in 30 s (roles may still be propagating)"; Start-Sleep -Seconds 30 }
}
$ErrorActionPreference = "Stop"
if (-not $ok) { throw "az containerapp update failed. Logs: az containerapp logs show -n $AppName -g $ResourceGroup" }
# Turns ingress on (first deploy) or keeps it as it is (later deploys).
AzRun containerapp ingress enable --name $AppName --resource-group $ResourceGroup --type external --target-port 8000 --transport auto -o none | Out-Null

# ---------------------------------------------------------------- check

$fqdn = AzRun containerapp show --name $AppName --resource-group $ResourceGroup --query properties.configuration.ingress.fqdn -o tsv
$url = "https://$fqdn/captionvar/"
Step "Checking $url"
$status = $null
for ($i = 1; $i -le 20 -and -not $status; $i++) {
  try {
    $health = Invoke-RestMethod -Uri "https://$fqdn/healthz" -TimeoutSec 20
    if ($health.ok) { $status = Invoke-RestMethod -Uri "https://$fqdn/captionvar/api/live/status" -TimeoutSec 20 }
  } catch { Start-Sleep -Seconds 10 }
}
if (-not $status) {
  Write-Warning "The app did not answer yet. Logs: az containerapp logs show -n $AppName -g $ResourceGroup --follow"
} else {
  Write-Host "  live: enabled=$($status.enabled) model=$($status.model) available=$($status.available) $($status.reason)"
}

Write-Host "`nCaptionVAR live:  $url" -ForegroundColor Green
Write-Host "Start a live run:  $($url)?live=1"
Write-Host "Switch live runs off (replay stays up):"
Write-Host "  az containerapp update -n $AppName -g $ResourceGroup --set-env-vars LIVE_ENABLED=0"
Write-Host "Delete everything:  az group delete -n $ResourceGroup --yes --no-wait"
