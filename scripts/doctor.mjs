#!/usr/bin/env node
// doctor.mjs — Opta Update System plane validator.
// Zero-dependency (Node >= 20 built-ins only). Usage: node scripts/doctor.mjs [--json]
// Validates manifests, signatures, history, index, and both serving endpoints.
// Design authority: Opta Update System foundation design (2026-06-11).

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const V1 = join(ROOT, "public", "v1");
const PRIMARY = "https://updates.optastack.ai/v1"; // KNOWN-dark (Vercel custody) — WARN while failover serves
const FAILOVER = "https://raw.githubusercontent.com/Optamize/opta-releases/main/public/v1";
const FLEET_KEY_ID = "5F4DCA2AABE47146";
const TIMEOUT_MS = 15_000;
const JSON_MODE = process.argv.includes("--json");

const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const RANK = { PASS: 0, WARN: 1, FAIL: 2 };

const results = []; // { check, status, subject, detail }
const add = (check, status, subject, detail = "") => results.push({ check, status, subject, detail });

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function probe(url, method = "GET") {
  try {
    const res = await fetch(url, { method, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: res.status, label: String(res.status) };
  } catch (err) {
    return { status: 0, label: `network-fail (${err.cause?.code ?? err.name})` };
  }
}

// ---------- discovery: app/channel pairs from index.json + disk scan ----------
function discover() {
  let index = null;
  try {
    index = readJson(join(V1, "index.json"));
  } catch (err) {
    add("INDEX", "FAIL", "public/v1/index.json", `unreadable: ${err.message}`);
  }
  const pairs = new Map(); // "app/channel" -> { app, channel, inIndex, onDisk }
  const ref = (app, channel) => {
    const key = `${app}/${channel}`;
    if (!pairs.has(key)) pairs.set(key, { app, channel, inIndex: false, onDisk: false });
    return pairs.get(key);
  };
  for (const [app, def] of Object.entries(index?.apps ?? {}))
    for (const channel of Object.keys(def.channels ?? {})) ref(app, channel).inIndex = true;
  const appsDir = join(V1, "apps");
  if (existsSync(appsDir))
    for (const app of readdirSync(appsDir, { withFileTypes: true }).filter((d) => d.isDirectory()))
      for (const ch of readdirSync(join(appsDir, app.name), { withFileTypes: true }).filter((d) => d.isDirectory()))
        if (existsSync(join(appsDir, app.name, ch.name, "latest.json"))) ref(app.name, ch.name).onDisk = true;
  return { index, pairs: [...pairs.values()] };
}

// ---------- check 1: ENDPOINTS ----------
async function checkEndpoints(pairs) {
  await Promise.all(
    pairs.map(async ({ app, channel }) => {
      const rel = `apps/${app}/${channel}/latest.json`;
      const [pri, fai] = await Promise.all([probe(`${PRIMARY}/${rel}`), probe(`${FAILOVER}/${rel}`)]);
      const failoverServes = fai.status === 200;
      add("ENDPOINTS", failoverServes ? "PASS" : "FAIL", `${app}/${channel} failover`, `${FAILOVER}/${rel} -> ${fai.label}`);
      if (pri.status === 200) add("ENDPOINTS", "PASS", `${app}/${channel} primary`, `${PRIMARY}/${rel} -> 200`);
      else
        add("ENDPOINTS", failoverServes ? "WARN" : "FAIL", `${app}/${channel} primary`,
          `${PRIMARY}/${rel} -> ${pri.label}${failoverServes ? " (known-dark: Vercel custody; failover serving)" : ""}`);
    })
  );
}

// ---------- checks 2-4: manifest schema, asset reachability, signature ----------
function isBase64(s) {
  return typeof s === "string" && s.length > 0 && /^[A-Za-z0-9+/]+=*$/.test(s.replace(/\s/g, "")) && Buffer.from(s, "base64").length > 0;
}

function parseMinisign(b64) {
  const lines = Buffer.from(b64, "base64").toString("utf8").split("\n");
  if (!lines[0]?.startsWith("untrusted comment:") || !lines[1]) throw new Error("not a minisign signature file");
  const raw = Buffer.from(lines[1], "base64");
  if (raw.length !== 74) throw new Error(`signature payload is ${raw.length} bytes, expected 74 (2 alg + 8 key_id + 64 sig)`);
  const alg = raw.subarray(0, 2).toString("latin1");
  if (alg !== "ED" && alg !== "Ed") throw new Error(`unknown algorithm tag "${alg}"`);
  return { alg, keyId: Buffer.from(raw.subarray(2, 10)).reverse().toString("hex").toUpperCase() };
}

async function checkManifests(pairs) {
  const assetProbes = [];
  for (const { app, channel, onDisk } of pairs) {
    const subject = `${app}/${channel}`;
    const dir = join(V1, "apps", app, channel);
    if (!onDisk) {
      add("MANIFEST", "FAIL", subject, "in index.json but no latest.json on disk");
      continue;
    }
    let manifest;
    try {
      manifest = readJson(join(dir, "latest.json"));
    } catch (err) {
      add("MANIFEST", "FAIL", `${subject} latest.json`, `unparseable: ${err.message}`);
      continue;
    }
    // -- schema: latest.json
    const faults = [];
    if (!SEMVER_RE.test(manifest.version ?? "")) faults.push(`version "${manifest.version}" not semver`);
    if (!ISO_RE.test(manifest.pub_date ?? "") || Number.isNaN(Date.parse(manifest.pub_date))) faults.push(`pub_date "${manifest.pub_date}" not ISO-8601`);
    const platforms = Object.entries(manifest.platforms ?? {});
    if (platforms.length === 0) faults.push("no platforms");
    for (const [key, p] of platforms) {
      if (typeof p.url !== "string" || !/^https:\/\//.test(p.url)) faults.push(`platforms.${key}.url missing/not https`);
      if (!isBase64(p.signature)) faults.push(`platforms.${key}.signature missing/not base64`);
    }
    add("MANIFEST", faults.length ? "FAIL" : "PASS", `${subject} latest.json`,
      faults.join("; ") || `v${manifest.version} · ${platforms.length} platform(s)`);
    // -- schema: release.meta.json
    try {
      const meta = readJson(join(dir, "release.meta.json"));
      const mf = [];
      if (meta.schema !== "opta.release-meta/1") mf.push(`schema "${meta.schema}" != opta.release-meta/1`);
      if (meta.version !== manifest.version) mf.push(`version "${meta.version}" != latest.json "${manifest.version}"`);
      if (!["hotfix", "feature"].includes(meta.class)) mf.push(`class "${meta.class}" not in {hotfix,feature}`);
      add("MANIFEST", mf.length ? "FAIL" : "PASS", `${subject} release.meta.json`,
        mf.join("; ") || `schema ok · v${meta.version} · class=${meta.class}`);
    } catch (err) {
      add("MANIFEST", "FAIL", `${subject} release.meta.json`, `missing/unparseable: ${err.message}`);
    }
    // -- assets + signatures per platform
    for (const [key, p] of platforms) {
      if (typeof p.url === "string")
        assetProbes.push(probe(p.url, "HEAD").then((r) =>
          add("ASSETS", r.status === 200 ? "PASS" : "FAIL", `${subject} ${key}`, `HEAD ${p.url} -> ${r.label}`)));
      try {
        const { alg, keyId } = parseMinisign(p.signature ?? "");
        if (keyId === FLEET_KEY_ID) add("SIGNATURES", "PASS", `${subject} ${key}`, `alg=${alg} key_id=${keyId} (fleet key)`);
        else add("SIGNATURES", "FAIL", `${subject} ${key}`, `key_id=${keyId} != fleet key ${FLEET_KEY_ID}`);
      } catch (err) {
        add("SIGNATURES", "FAIL", `${subject} ${key}`, err.message);
      }
    }
  }
  await Promise.all(assetProbes);
}

// ---------- check 5: HISTORY ----------
function checkHistory(pairs) {
  const histDir = join(ROOT, "history");
  if (!existsSync(histDir)) return add("HISTORY", "WARN", "history/", "directory missing");
  let compared = 0;
  for (const { app, channel, onDisk } of pairs) {
    if (!onDisk) continue;
    const latestPath = join(V1, "apps", app, channel, "latest.json");
    const version = (() => { try { return readJson(latestPath).version; } catch { return null; } })();
    if (!version) continue;
    const histPath = join(histDir, app, `${version}.json`);
    if (!existsSync(histPath)) {
      add("HISTORY", "FAIL", `${app}/${channel} v${version}`, `history/${app}/${version}.json missing for current latest`);
      continue;
    }
    compared++;
    if (readFileSync(histPath).equals(readFileSync(latestPath)))
      add("HISTORY", "PASS", `${app}/${channel} v${version}`, `byte-identical to history/${app}/${version}.json`);
    else add("HISTORY", "FAIL", `${app}/${channel} v${version}`, `history/${app}/${version}.json differs from latest.json`);
  }
  if (compared === 0) add("HISTORY", "WARN", "history/", "no current versions found to compare");
}

// ---------- check 6: INDEX ----------
function checkIndex(index, pairs) {
  if (!index) return; // unreadable already FAILed in discover()
  if (index.schema !== "opta.fleet-index/1")
    add("INDEX", "WARN", "index.json schema", `"${index.schema}" != opta.fleet-index/1`);
  for (const { app, channel, inIndex, onDisk } of pairs) {
    const subject = `${app}/${channel}`;
    if (inIndex && !onDisk) add("INDEX", "FAIL", subject, "listed in index.json but absent on disk");
    else if (!inIndex && onDisk) add("INDEX", "FAIL", subject, "latest.json on disk but missing from index.json");
    else {
      const indexed = index.apps?.[app]?.channels?.[channel];
      const actual = (() => { try { return readJson(join(V1, "apps", app, channel, "latest.json")).version; } catch { return null; } })();
      if (indexed === actual) add("INDEX", "PASS", subject, `index v${indexed} == disk v${actual}`);
      else add("INDEX", "FAIL", subject, `index says v${indexed}, disk latest.json says v${actual}`);
    }
  }
}

// ---------- run + report ----------
const { index, pairs } = discover();
if (pairs.length === 0) add("INDEX", "FAIL", "discovery", "no app/channel pairs found in index.json or on disk");
await Promise.all([checkEndpoints(pairs), checkManifests(pairs)]);
checkHistory(pairs);
checkIndex(index, pairs);

const CHECK_ORDER = ["ENDPOINTS", "MANIFEST", "ASSETS", "SIGNATURES", "HISTORY", "INDEX"];
const checks = {};
for (const name of CHECK_ORDER) {
  const items = results.filter((r) => r.check === name);
  const status = items.reduce((worst, r) => (RANK[r.status] > RANK[worst] ? r.status : worst), "PASS");
  checks[name] = { status, items: items.map(({ status, subject, detail }) => ({ status, subject, detail })) };
}
const counts = { PASS: 0, WARN: 0, FAIL: 0 };
for (const r of results) counts[r.status]++;
const exitCode = counts.FAIL > 0 ? 1 : 0;

if (JSON_MODE) {
  console.log(JSON.stringify({
    schema: "opta.doctor-report/1",
    generated: new Date().toISOString(),
    repo: ROOT,
    fleet_key_id: FLEET_KEY_ID,
    pairs: pairs.map(({ app, channel }) => `${app}/${channel}`),
    checks,
    summary: { ...counts, exit_code: exitCode },
  }, null, 2));
} else {
  console.log(`Opta Update Plane Doctor — ${new Date().toISOString()}`);
  console.log(`repo: ${ROOT}`);
  console.log(`pairs: ${pairs.map(({ app, channel }) => `${app}/${channel}`).join(", ") || "(none)"}\n`);
  const width = Math.max(...results.map((r) => r.subject.length), 10);
  for (const name of CHECK_ORDER) {
    console.log(`${name}  —  ${checks[name].status}`);
    for (const r of checks[name].items)
      console.log(`  [${r.status.padEnd(4)}] ${r.subject.padEnd(width)}  ${r.detail}`);
    console.log("");
  }
  console.log(`SUMMARY: ${counts.PASS} pass · ${counts.WARN} warn · ${counts.FAIL} fail — exit ${exitCode}`);
}
process.exit(exitCode);
