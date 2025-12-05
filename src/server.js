// src/server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { exec } = require("child_process");

// -------------------- Config --------------------

const app = express();
const PORT = process.env.PORT || 4000;

const ELECTRICITYMAPS_API_KEY = process.env.ELECTRICITYMAPS_API_KEY || "";
const ELECTRICITYMAPS_API_BASE_URL = "https://api.electricitymaps.com/v3";

// For deployment to CIVO via kubectl
// You MUST have kubectl configured locally with context pointing to your CIVO cluster.
const ENABLE_CIVO_DEPLOY = process.env.ENABLE_CIVO_DEPLOY === "true";
const KUBECTL_CONTEXT = process.env.KUBECTL_CONTEXT || ""; // optional

// Currency conversion (approx, for estimation only)
const USD_TO_INR = parseFloat(process.env.USD_TO_INR || "85.0");

// Allow frontend on any origin (for dev + demo)
app.use(
  cors({
    origin: "*",
  })
);

app.use(express.json());

if (!ELECTRICITYMAPS_API_KEY) {
  console.warn(
    "⚠️  ELECTRICITYMAPS_API_KEY not set. Falling back to static carbon intensities."
  );
}

if (!ENABLE_CIVO_DEPLOY) {
  console.warn(
    '⚠️  ENABLE_CIVO_DEPLOY is not "true". /api/deploy will run in DRY-RUN mode (no kubectl apply).'
  );
}

// -------------------- Region metadata (CIVO-style) --------------------
// defaultCarbonIntensity: fallback in gCO2eq/kWh if API fails or no key
// baseCost: APPROX hourly cost per replica in USD (for cost estimation)
// geoGroup: used to approximate latency vs userRegion

const REGIONS = [
  {
    id: "LON1",
    label: "London, UK",
    defaultCarbonIntensity: 260,
    baseCost: 0.24,
    geoGroup: "eu",
  },
  {
    id: "FRA1",
    label: "Frankfurt, Germany",
    defaultCarbonIntensity: 210,
    baseCost: 0.26,
    geoGroup: "eu",
  },
  {
    id: "NYC1",
    label: "New York, USA",
    defaultCarbonIntensity: 390,
    baseCost: 0.23,
    geoGroup: "us-east",
  },
  {
    id: "SFO1",
    label: "San Francisco, USA",
    defaultCarbonIntensity: 380,
    baseCost: 0.27,
    geoGroup: "us-west",
  },
  {
    id: "BLR1",
    label: "Bengaluru, India",
    defaultCarbonIntensity: 650,
    baseCost: 0.18,
    geoGroup: "ap-south",
  },
  {
    id: "SGP1",
    label: "Singapore",
    defaultCarbonIntensity: 510,
    baseCost: 0.21,
    geoGroup: "ap-southeast",
  },
];

// Map our pseudo CIVO regions → Electricity Maps zone codes
// Docs: /v3/carbon-intensity/latest?zone=ZONE_ID with auth-token header
const REGION_ZONE_MAP = {
  LON1: { zone: "GB" },           // UK
  FRA1: { zone: "DE" },           // Germany
  NYC1: { zone: "US-NY-NYIS" },   // New York ISO
  SFO1: { zone: "US-CAL-CISO" },  // California ISO
  BLR1: { zone: "IN" },           // Mainland India (proxy for Bengaluru)
  SGP1: { zone: "SG" },           // Singapore
};

// -------------------- Simple in-memory analytics store --------------------
// We record each deployment here when /api/deploy is called.
const DEPLOYMENTS_HISTORY = [];

// -------------------- Helper functions --------------------

function normalizeScores(values, invert = false) {
  if (!values.length) return [];
  let v = [...values];
  if (invert) {
    v = v.map((x) => -x); // lower input -> higher score
  }
  const min = Math.min(...v);
  const max = Math.max(...v);
  if (max === min) {
    // all equal, give neutral scores
    return v.map(() => 0.7);
  }
  return v.map((x) => (x - min) / (max - min));
}

function latencyBaseScore(userRegion, region) {
  // Very rough approximation: higher score = closer = lower latency
  const map = {
    "ap-south": "ap-south",
    "eu-west": "eu",
    "us-east": "us-east",
    "us-west": "us-west",
    global: "global",
  };

  const target = map[userRegion] || "global";

  if (target === "global") {
    // global workload: everyone is "medium"
    return 0.6;
  }

  if (target === "ap-south") {
    if (region.geoGroup === "ap-south") return 1.0;
    if (region.geoGroup === "ap-southeast") return 0.85;
    if (region.geoGroup === "eu") return 0.6;
    if (region.geoGroup.startsWith("us")) return 0.45;
  }

  if (target === "eu") {
    if (region.geoGroup === "eu") return 1.0;
    if (region.geoGroup === "us-east") return 0.8;
    if (region.geoGroup === "us-west") return 0.7;
    if (region.geoGroup.startsWith("ap")) return 0.55;
  }

  if (target === "us-east") {
    if (region.geoGroup === "us-east") return 1.0;
    if (region.geoGroup === "eu") return 0.8;
    if (region.geoGroup === "us-west") return 0.75;
    if (region.geoGroup.startsWith("ap")) return 0.5;
  }

  if (target === "us-west") {
    if (region.geoGroup === "us-west") return 1.0;
    if (region.geoGroup === "us-east") return 0.8;
    if (region.geoGroup === "ap-southeast") return 0.7;
    if (region.geoGroup === "eu") return 0.6;
    if (region.geoGroup === "ap-south") return 0.5;
  }

  return 0.6;
}

// adjust weights based on strategy + latencyTolerance, and renormalize to 1
function getWeights(strategy, latencyTolerance) {
  let wCo2, wLat, wCost;

  switch (strategy) {
    case "max-green":
      wCo2 = 0.6;
      wLat = 0.25;
      wCost = 0.15;
      break;
    case "budget":
      wCo2 = 0.15;
      wLat = 0.25;
      wCost = 0.6;
      break;
    case "balanced":
    default:
      wCo2 = 0.34;
      wLat = 0.33;
      wCost = 0.33;
      break;
  }

  if (latencyTolerance === "strict") {
    wLat *= 1.2;
    wCo2 *= 0.9;
    wCost *= 0.9;
  } else if (latencyTolerance === "relaxed") {
    wLat *= 0.7;
    wCo2 *= 1.1;
    wCost *= 1.1;
  }

  const sum = wCo2 + wLat + wCost;
  return {
    co2: wCo2 / sum,
    latency: wLat / sum,
    cost: wCost / sum,
  };
}

function countRuntimeComponents(components) {
  const runtimeTypes = new Set(["api-gateway", "frontend", "container", "function"]);
  return components.filter((c) => runtimeTypes.has(c.type)).length;
}

function calcReplicas(components, latencyTolerance) {
  const runtimeCount = countRuntimeComponents(components);
  let replicas = Math.max(1, Math.ceil(runtimeCount / 2));

  if (latencyTolerance === "strict" && runtimeCount > 1) {
    replicas += 1;
  }

  if (replicas > 4) replicas = 4;
  return replicas;
}

function generateKubernetesYaml(planId, regionId, instanceClass, replicas, components) {
  const runtimeTypes = new Set(["api-gateway", "frontend", "container", "function"]);
  const runtimeComponents = components.filter((c) => runtimeTypes.has(c.type));

  const lines = [];

  // Namespace
  lines.push(
    "apiVersion: v1",
    "kind: Namespace",
    "metadata:",
    "  name: greenops-app",
    "  labels:",
    "    greenops-plan: " + planId,
    ""
  );

  // If no runtime components, just return namespace
  if (runtimeComponents.length === 0) {
    return lines.join("\n");
  }

  // Deployment per runtime component
  runtimeComponents.forEach((comp) => {
    const safeName =
      comp.name.toLowerCase().replace(/[^a-z0-9-]/g, "-") || "service";
    lines.push(
      "---",
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      `  name: ${safeName}`,
      "  namespace: greenops-app",
      "  labels:",
      `    app: ${safeName}`,
      `    greenops-plan: ${planId}`,
      "spec:",
      `  replicas: ${replicas}`,
      "  selector:",
      "    matchLabels:",
      `      app: ${safeName}`,
      "  template:",
      "    metadata:",
      "      labels:",
      `        app: ${safeName}`,
      `        greenops-plan: ${planId}`,
      "    spec:",
      "      containers:",
      "        - name: " + safeName,
      "          image: your-docker-username/" + safeName + ":latest",
      "          ports:",
      "            - containerPort: 4000",
      "          env:",
      "            - name: GREENOPS_PLAN_ID",
      "              value: \"" + planId + "\"",
      "            - name: GREENOPS_REGION",
      "              value: \"" + regionId + "\"",
      "            - name: GREENOPS_INSTANCE_CLASS",
      "              value: \"" + instanceClass + "\"",
      ""
    );
  });

  // Service for API gateway or first runtime component
  let gatewayName = null;
  const apiGateway = runtimeComponents.find((c) => c.type === "api-gateway");
  if (apiGateway) {
    gatewayName = apiGateway.name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  } else if (runtimeComponents.length > 0) {
    gatewayName = runtimeComponents[0].name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  }

  if (gatewayName) {
    lines.push(
      "---",
      "apiVersion: v1",
      "kind: Service",
      "metadata:",
      "  name: " + gatewayName + "-svc",
      "  namespace: greenops-app",
      "spec:",
      "  type: LoadBalancer",
      "  selector:",
      "    app: " + gatewayName,
      "  ports:",
      "    - name: http",
      "      port: 80",
      "      targetPort: 4000",
      ""
    );
  }

  return lines.join("\n");
}

// Fetch live carbon intensity (gCO2eq/kWh) for a region using Electricity Maps
async function getCarbonIntensityForRegion(region) {
  const mapping = REGION_ZONE_MAP[region.id];

  // No key or no mapping => fallback to static default
  if (!ELECTRICITYMAPS_API_KEY || !mapping) {
    return {
      value: region.defaultCarbonIntensity,
      source: "fallback-static",
    };
  }

  const zone = mapping.zone;
  const url = `${ELECTRICITYMAPS_API_BASE_URL}/carbon-intensity/latest?zone=${encodeURIComponent(
    zone
  )}`;

  try {
    const resp = await fetch(url, {
      headers: {
        "auth-token": ELECTRICITYMAPS_API_KEY,
      },
    });

    if (!resp.ok) {
      console.warn(
        `⚠️  Electricity Maps API error for region ${region.id} / zone ${zone}:`,
        resp.status,
        await resp.text()
      );
      return {
        value: region.defaultCarbonIntensity,
        source: "fallback-static",
      };
    }

    const data = await resp.json();
    // response contains carbonIntensity in gCO2eq/kWh
    const ci = data.carbonIntensity;

    if (typeof ci !== "number") {
      console.warn(
        `⚠️  Electricity Maps returned no numeric carbonIntensity for ${region.id}, using fallback.`
      );
      return {
        value: region.defaultCarbonIntensity,
        source: "fallback-static",
      };
    }

    return {
      value: ci,
      source: "electricitymaps",
    };
  } catch (err) {
    console.error(
      `⚠️  Error calling Electricity Maps for ${region.id}:`,
      err.message
    );
    return {
      value: region.defaultCarbonIntensity,
      source: "fallback-static",
    };
  }
}

function execShellCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        return reject({ error, stdout, stderr });
      }
      resolve({ stdout, stderr });
    });
  });
}

// -------------------- Routes --------------------

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    app: "GreenOps CIVO Backend",
    message: "Green by default 🌱",
    electricityMaps: {
      configured: !!ELECTRICITYMAPS_API_KEY,
    },
    deploy: {
      enabled: ENABLE_CIVO_DEPLOY,
      kubectlContext: KUBECTL_CONTEXT || null,
    },
    currency: {
      usdToInr: USD_TO_INR,
    },
  });
});

// Main planner endpoint
app.post("/api/plan", async (req, res) => {
  const {
    components = [],
    userRegion = "global",
    latencyTolerance = "balanced",
    optimizationPreference = "balanced",
  } = req.body || {};

  // Basic validation
  if (!Array.isArray(components) || components.length === 0) {
    return res.status(400).json({
      error: "At least one component is required to generate a plan.",
    });
  }

  // 1) Get **live** carbon-intensity per region (with safe fallback)
  const carbonResults = await Promise.all(
    REGIONS.map((r) => getCarbonIntensityForRegion(r))
  );
  const carbonValues = carbonResults.map((r) => r.value);

  // 2) Compute cost / latency values for each region
  const costValues = REGIONS.map((r) => r.baseCost);
  const co2Scores = normalizeScores(carbonValues, true); // lower gCO2 → higher score
  const costScores = normalizeScores(costValues, true);  // lower cost → higher score
  const latencyScores = REGIONS.map((r) => latencyBaseScore(userRegion, r));

  // Attach scores and live CI to region objects
  const regionScores = REGIONS.map((r, idx) => ({
    region: {
      ...r,
      liveCarbonIntensity: carbonValues[idx],
      carbonSource: carbonResults[idx].source,
    },
    co2: co2Scores[idx],
    cost: costScores[idx],
    latency: latencyScores[idx],
  }));

  // 3) Compute replicas recommendation
  const recommendedReplicas = calcReplicas(components, latencyTolerance);

  // 4) Define strategies
  const strategies = [
    { id: "balanced", label: "Balanced" },
    { id: "max-green", label: "Max Green" },
    { id: "budget", label: "Budget Friendly" },
  ];

  const plans = [];

  strategies.forEach((strategy) => {
    const weights = getWeights(strategy.id, latencyTolerance);

    // For each region, compute overall score for this strategy
    const scoredRegions = regionScores.map((rs) => {
      const overall =
        rs.co2 * weights.co2 +
        rs.latency * weights.latency +
        rs.cost * weights.cost;

      return {
        ...rs,
        overall,
      };
    });

    // Pick best region for this strategy
    scoredRegions.sort((a, b) => b.overall - a.overall);
    const best = scoredRegions[0];

    // Choose instance class based on strategy
    let instanceClass;
    if (strategy.id === "max-green") {
      instanceClass = "eco-small";
    } else if (strategy.id === "budget") {
      instanceClass = "standard-small";
    } else {
      instanceClass = "standard-medium";
    }

    const rounded = (x) => Math.round(x * 100) / 100;

    const plan = {
      id: strategy.id,
      label: strategy.label + " Plan",
      description:
        strategy.id === "max-green"
          ? "Prioritizes regions with lower carbon intensity while still keeping latency and cost within acceptable bounds."
          : strategy.id === "budget"
          ? "Prioritizes lower-cost regions and instance types, while keeping latency and carbon footprint reasonable."
          : "Balanced trade-off between carbon efficiency, latency, and cost for general workloads.",
      scores: {
        co2: rounded(best.co2),
        latency: rounded(best.latency),
        cost: rounded(best.cost),
        overall: rounded(best.overall),
      },
      carbonIntensity: {
        value_gCo2PerKwh: rounded(best.region.liveCarbonIntensity),
        source: best.region.carbonSource, // "electricitymaps" or "fallback-static"
      },
      civo: {
        region: best.region.id,
        regionLabel: best.region.label,
        clusterType: "kubernetes",
        instanceClass,
        replicas: recommendedReplicas,
      },
      notes: [
        `Strategy: ${strategy.label}`,
        `Selected region ${best.region.id} (${best.region.label}) based on combined CO₂, latency, and cost scores.`,
        `Estimated grid carbon intensity: ${rounded(
          best.region.liveCarbonIntensity
        )} gCO₂eq/kWh (source: ${best.region.carbonSource}).`,
        `Recommended replicas: ${recommendedReplicas} (derived from ${countRuntimeComponents(
          components
        )} runtime components and "${latencyTolerance}" latency tolerance).`,
        `Weights used — CO₂: ${rounded(weights.co2)}, Latency: ${rounded(
          weights.latency
        )}, Cost: ${rounded(weights.cost)}.`,
      ],
      kubernetesYaml: generateKubernetesYaml(
        strategy.id,
        best.region.id,
        instanceClass,
        recommendedReplicas,
        components
      ),
    };

    plans.push(plan);
  });

  res.json({
    inputEcho: {
      components,
      userRegion,
      latencyTolerance,
      optimizationPreference,
    },
    electricityMaps: {
      enabled: !!ELECTRICITYMAPS_API_KEY,
    },
    plans,
  });
});

// -------------------- Deploy to CIVO endpoint --------------------
// Expected body from frontend:
// {
//   planId: string,
//   region: string,
//   regionLabel: string,
//   carbonIntensity: number, // gCO2/kWh
//   replicas: number,
//   scores: { co2, latency, cost, overall },
//   kubernetesYaml: string
// }
app.post("/api/deploy", async (req, res) => {
  const {
    planId,
    region,
    regionLabel,
    carbonIntensity,
    replicas,
    scores,
    kubernetesYaml,
  } = req.body || {};

  if (!planId || !region || !kubernetesYaml) {
    return res.status(400).json({
      error: "planId, region, and kubernetesYaml are required to deploy.",
    });
  }

  // Approximate energy + CO2 impact for analytics
  // Assumption: each replica ~ 0.1 kW (100W), so hourlyEnergyKwh = 0.1 * replicas
  const safeReplicas = typeof replicas === "number" && replicas > 0 ? replicas : 1;
  const assumedPowerKwPerReplica = 0.1;
  const hourlyEnergyKwh = safeReplicas * assumedPowerKwPerReplica;

  // carbonIntensity is gCO2/kWh -> convert to kg
  const ci = typeof carbonIntensity === "number" ? carbonIntensity : 500; // fallback
  const estimatedHourlyCO2Kg = (ci / 1000) * hourlyEnergyKwh;

  // Approximate cost per hour: baseCost (USD per replica) * replicas
  const regionMeta = REGIONS.find((r) => r.id === region);
  const baseCostUsdPerReplica = regionMeta?.baseCost ?? 0.25;
  const estimatedHourlyCostUsd = baseCostUsdPerReplica * safeReplicas;
  const estimatedHourlyCostInr = estimatedHourlyCostUsd * USD_TO_INR;

  const now = new Date().toISOString();

  // Store in in-memory analytics history
  DEPLOYMENTS_HISTORY.push({
    timestamp: now,
    planId,
    region,
    regionLabel: regionLabel || region,
    carbonIntensity_gCo2PerKwh: ci,
    replicas: safeReplicas,
    scores: scores || null,
    estimatedHourlyEnergyKwh: Number(hourlyEnergyKwh.toFixed(3)),
    estimatedHourlyCO2Kg: Number(estimatedHourlyCO2Kg.toFixed(3)),
    estimatedHourlyCostUsd: Number(estimatedHourlyCostUsd.toFixed(4)),
    estimatedHourlyCostInr: Number(estimatedHourlyCostInr.toFixed(2)),
  });

  // Prepare kubectl command
  const tmpFile = path.join(
    os.tmpdir(),
    `greenops-plan-${Date.now()}-${planId}.yaml`
  );
  try {
    await fs.promises.writeFile(tmpFile, kubernetesYaml, "utf8");
  } catch (err) {
    console.error("❌ Failed to write temp YAML file:", err.message);
    return res.status(500).json({
      error: "Failed to write temporary YAML file for deployment.",
      details: err.message,
    });
  }

  const baseCmd = KUBECTL_CONTEXT
    ? `kubectl --context ${KUBECTL_CONTEXT} apply -f "${tmpFile}"`
    : `kubectl apply -f "${tmpFile}"`;

  // If deployment is disabled, just simulate success (for hackathon demo or dry-run)
  if (!ENABLE_CIVO_DEPLOY) {
    console.log("💡 DRY-RUN: would execute:", baseCmd);
    return res.json({
      status: "dry-run",
      message:
        "Deployment recorded for analytics, but kubectl apply was not executed because ENABLE_CIVO_DEPLOY is not true.",
      command: baseCmd,
      analytics: {
        timestamp: now,
        estimatedHourlyEnergyKwh: Number(hourlyEnergyKwh.toFixed(3)),
        estimatedHourlyCO2Kg: Number(estimatedHourlyCO2Kg.toFixed(3)),
        estimatedHourlyCostUsd: Number(estimatedHourlyCostUsd.toFixed(4)),
        estimatedHourlyCostInr: Number(estimatedHourlyCostInr.toFixed(2)),
      },
    });
  }

  try {
    const { stdout, stderr } = await execShellCommand(baseCmd);
    console.log("✅ kubectl apply output:", stdout);
    if (stderr) {
      console.warn("⚠️ kubectl apply stderr:", stderr);
    }

    return res.json({
      status: "ok",
      message: "Deployment applied to CIVO cluster via kubectl.",
      command: baseCmd,
      kubectl: { stdout, stderr },
      analytics: {
        timestamp: now,
        estimatedHourlyEnergyKwh: Number(hourlyEnergyKwh.toFixed(3)),
        estimatedHourlyCO2Kg: Number(estimatedHourlyCO2Kg.toFixed(3)),
        estimatedHourlyCostUsd: Number(estimatedHourlyCostUsd.toFixed(4)),
        estimatedHourlyCostInr: Number(estimatedHourlyCostInr.toFixed(2)),
      },
    });
  } catch (e) {
    console.error("❌ kubectl apply failed:", e);
    return res.status(500).json({
      status: "error",
      message: "kubectl apply failed. Check server logs.",
      command: baseCmd,
      error: e.error ? e.error.message : String(e),
      stdout: e.stdout,
      stderr: e.stderr,
    });
  }
});

// -------------------- Analytics endpoint --------------------
// Returns deployment history + aggregate CO2 + cost metrics
app.get("/api/analytics", (req, res) => {
  const deployments = DEPLOYMENTS_HISTORY;
  const totalDeployments = deployments.length;

  let totalCO2 = 0;
  let totalCI = 0;
  let totalCostUsd = 0;
  let baselineCostUsd = 0;

  const byPlan = {};   // { planId: { deployments, totalCO2, totalCI, totalCostUsd } }
  const byRegion = {}; // { region: { deployments, totalCO2, totalCI, totalCostUsd } }

  const maxBaseCost = Math.max(...REGIONS.map((r) => r.baseCost));

  deployments.forEach((d) => {
    totalCO2 += d.estimatedHourlyCO2Kg;
    totalCI += d.carbonIntensity_gCo2PerKwh;
    totalCostUsd += d.estimatedHourlyCostUsd;

    // baseline cost = maxBaseCost * replicas
    baselineCostUsd += maxBaseCost * d.replicas;

    // by plan
    if (!byPlan[d.planId]) {
      byPlan[d.planId] = {
        planId: d.planId,
        deployments: 0,
        totalCO2: 0,
        totalCI: 0,
        totalCostUsd: 0,
      };
    }
    byPlan[d.planId].deployments += 1;
    byPlan[d.planId].totalCO2 += d.estimatedHourlyCO2Kg;
    byPlan[d.planId].totalCI += d.carbonIntensity_gCo2PerKwh;
    byPlan[d.planId].totalCostUsd += d.estimatedHourlyCostUsd;

    // by region
    if (!byRegion[d.region]) {
      byRegion[d.region] = {
        region: d.region,
        regionLabel: d.regionLabel,
        deployments: 0,
        totalCO2: 0,
        totalCI: 0,
        totalCostUsd: 0,
      };
    }
    byRegion[d.region].deployments += 1;
    byRegion[d.region].totalCO2 += d.estimatedHourlyCO2Kg;
    byRegion[d.region].totalCI += d.carbonIntensity_gCo2PerKwh;
    byRegion[d.region].totalCostUsd += d.estimatedHourlyCostUsd;
  });

  const avgCI = totalDeployments > 0 ? totalCI / totalDeployments : 0;
  const baselineCostInr = baselineCostUsd * USD_TO_INR;
  const totalCostInr = totalCostUsd * USD_TO_INR;
  const savingsUsd = baselineCostUsd - totalCostUsd;
  const savingsInr = savingsUsd * USD_TO_INR;

  const byPlanArray = Object.values(byPlan).map((p) => ({
    ...p,
    avgCI: p.deployments > 0 ? p.totalCI / p.deployments : 0,
    avgCostUsd: p.deployments > 0 ? p.totalCostUsd / p.deployments : 0,
    totalCostInr: Number((p.totalCostUsd * USD_TO_INR).toFixed(2)),
  }));

  const byRegionArray = Object.values(byRegion).map((r) => ({
    ...r,
    avgCI: r.deployments > 0 ? r.totalCI / r.deployments : 0,
    avgCostUsd: r.deployments > 0 ? r.totalCostUsd / r.deployments : 0,
    totalCostInr: Number((r.totalCostUsd * USD_TO_INR).toFixed(2)),
  }));

  res.json({
    summary: {
      totalDeployments,
      totalEstimatedHourlyCO2Kg: Number(totalCO2.toFixed(3)),
      averageCarbonIntensity_gCo2PerKwh: Number(avgCI.toFixed(2)),
      totalEstimatedHourlyCostUsd: Number(totalCostUsd.toFixed(4)),
      totalEstimatedHourlyCostInr: Number(totalCostInr.toFixed(2)),
      baselineEstimatedHourlyCostUsd: Number(baselineCostUsd.toFixed(4)),
      baselineEstimatedHourlyCostInr: Number(baselineCostInr.toFixed(2)),
      estimatedHourlySavingsUsd: Number(savingsUsd.toFixed(4)),
      estimatedHourlySavingsInr: Number(savingsInr.toFixed(2)),
    },
    byPlan: byPlanArray,
    byRegion: byRegionArray,
    deployments,
    currency: {
      usdToInr: USD_TO_INR,
    },
  });
});

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(PORT, () => {
  console.log(`✅ GreenOps backend running on http://localhost:${PORT}`);
});