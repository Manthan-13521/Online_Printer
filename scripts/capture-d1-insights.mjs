// Read-only Cloudflare D1 Query Insights capture. Bound values are not returned
// by Query Insights; still treat the resulting SQL text as operational evidence.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const outputDirectory = "docs/evidence/d1-usage-optimization/cloud";
mkdirSync(outputDirectory, { recursive: true });

const common = [
  "--filter",
  "@printgo/worker",
  "exec",
  "wrangler",
  "d1",
  "insights",
  "printgo-production",
  "--config",
  "wrangler.jsonc",
  "--time-period",
  "1d",
  "--sort-type",
  "sum",
  "--limit",
  "30",
  "--json",
];

const capturedAt = new Date().toISOString();
for (const sortBy of ["reads", "writes", "count"]) {
  const result = spawnSync(
    "pnpm",
    [...common.slice(0, -1), "--sort-by", sortBy, "--json"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        WRANGLER_HIDE_BANNER: "true",
        WRANGLER_SEND_METRICS: "false",
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `D1 insights (${sortBy}) failed: ${result.stderr || result.stdout}`,
    );
  }
  const parsed = JSON.parse(result.stdout);
  writeFileSync(
    `${outputDirectory}/${sortBy}.json`,
    `${JSON.stringify(parsed, null, 2)}\n`,
  );
}

writeFileSync(
  `${outputDirectory}/metadata.json`,
  `${JSON.stringify(
    {
      capturedAt,
      evidence: "MEASURED CLOUD",
      accountId: "ba188f82338d7a85fc6f79913fb6a653",
      databaseName: "printgo-production",
      databaseId: "81bc9e6b-6e65-4a8a-85dd-4440484482ff",
      timePeriod: "1d",
      note: "Read-only Query Insights. Query parameters are omitted by Cloudflare.",
    },
    null,
    2,
  )}\n`,
);

console.log(`Captured read-only D1 insights in ${outputDirectory}`);
