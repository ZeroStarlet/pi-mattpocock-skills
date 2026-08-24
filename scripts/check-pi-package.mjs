#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const pluginJson = JSON.parse(
  readFileSync(join(repo, ".claude-plugin", "plugin.json"), "utf8"),
);

const expectedPiSkillRoots = [
  "./skills/engineering",
  "./skills/productivity",
];
const expectedPiExtensions = ["./extensions/pi-compat.ts"];

function promotedSkillPaths() {
  return expectedPiSkillRoots.flatMap((root) => {
    const absoluteRoot = join(repo, root);
    return readdirSync(absoluteRoot, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          existsSync(join(absoluteRoot, entry.name, "SKILL.md")),
      )
      .map((entry) => `${root}/${entry.name}`);
  });
}

function compare(label, actual, expected) {
  const normalizedActual = [...(actual ?? [])].sort();
  const normalizedExpected = [...expected].sort();
  if (JSON.stringify(normalizedActual) === JSON.stringify(normalizedExpected)) {
    console.log(`${label} is in sync (${normalizedExpected.length} entries)`);
    return true;
  }

  const missing = normalizedExpected.filter(
    (entry) => !normalizedActual.includes(entry),
  );
  const extra = normalizedActual.filter(
    (entry) => !normalizedExpected.includes(entry),
  );

  console.error(`${label} is out of sync.`);
  if (missing.length > 0) console.error(`  Missing: ${missing.join(", ")}`);
  if (extra.length > 0) console.error(`  Extra: ${extra.join(", ")}`);
  return false;
}

const expectedPromotedSkills = promotedSkillPaths();
const checks = [
  compare("package.json pi.skills", packageJson.pi?.skills, expectedPiSkillRoots),
  compare(
    "package.json pi.extensions",
    packageJson.pi?.extensions,
    expectedPiExtensions,
  ),
  compare(
    ".claude-plugin/plugin.json skills",
    pluginJson.skills,
    expectedPromotedSkills,
  ),
];

for (const extension of expectedPiExtensions) {
  if (!existsSync(join(repo, extension))) {
    console.error(`Missing PI extension: ${extension}`);
    checks.push(false);
  }
}

if (!packageJson.keywords?.includes("pi-package")) {
  console.error('package.json keywords must include "pi-package".');
  checks.push(false);
}

if (checks.includes(false)) process.exit(1);
