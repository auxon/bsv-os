/**
 * `bsv doctor`: machine-check the gotcha table (AGENT-ECONOMY.md §12).
 *
 * Field bugs kept recurring from human memory — uncapped origins, dangling
 * deferred sign rounds, stale shell panels, auto mode without Jev. Doctor
 * turns each one into a check with a remediation: { ok, checks: [...] }.
 * `fail` means something is actively broken; `warn` means look soon.
 */
import type { Knex } from "knex";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getStatus, type CustodyStatus } from "./custody.ts";
import { jevEnabled } from "./jev.ts";
import { listPolicies, pendingRequests } from "./policy.ts";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorDeps {
  /** Test seam: production uses the custody lock state. */
  status?: () => Promise<CustodyStatus>;
}

function ago(createdAt: number): string {
  const s = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function sha256File(p: string): string | null {
  try {
    return createHash("sha256").update(fs.readFileSync(p, "utf8"), "utf8").digest("hex");
  } catch {
    return null;
  }
}

/** Exported for tests: compare an installed file against source candidates. */
export function checkPanelSync(installed: string, sources: string[]): DoctorCheck {
  if (!sha256File(installed)) {
    return {
      id: "plugin", status: "warn",
      detail: `shell plugin not installed at ${installed} — sync it (scripts/install.sh step 4) and rescan`,
    };
  }
  for (const src of sources) {
    const have = sha256File(src);
    if (have) {
      return have === sha256File(installed)
        ? { id: "plugin", status: "ok", detail: `installed panel matches ${src}` }
        : {
          id: "plugin", status: "warn",
          detail: `installed panel differs from ${src} — re-sync and rescan (omarchy-shell shell rescanPlugins)`,
        };
    }
  }
  return { id: "plugin", status: "warn", detail: "no plugin source found to compare against — skipping skew check" };
}

function panelSources(): string[] {
  const here = path.dirname(new URL(import.meta.url).pathname); // .../dist or .../src
  return [
    "/usr/share/bsv-os/shell-plugin/Panel.qml",
    path.resolve(here, "..", "..", "shell", "plugin", "Panel.qml"), // repo: walletd/{dist,src} -> shell
    path.resolve(here, "..", "shell", "plugin", "Panel.qml"),
  ];
}

export async function runDoctor(db: Knex, deps: DoctorDeps = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  const status = deps.status ? await deps.status() : await getStatus();
  if (!status.hasWallet) {
    checks.push({ id: "wallet", status: "fail", detail: "no wallet enrolled — run bsv create (or bsv import)" });
  } else if (status.locked) {
    checks.push({ id: "wallet", status: "warn", detail: "wallet locked — run bsv unlock before spending" });
  } else {
    checks.push({ id: "wallet", status: "ok", detail: "wallet enrolled and unlocked" });
  }

  if (await db.schema.hasTable("brc100_pending")) {
    const staged = (await db("brc100_pending").select("reference", "created_at").orderBy("created_at")) as Array<{
      reference: string; created_at: number;
    }>;
    checks.push(
      staged.length > 0
        ? {
          id: "sign-rounds", status: "fail",
          detail: `${staged.length} dangling sign round(s), oldest ${ago(staged[0]!.created_at)} ago (${staged[0]!.reference.slice(0, 12)}…) — complete or abort them; CANNOT_SIGN blocks new actions`,
        }
        : { id: "sign-rounds", status: "ok", detail: "no dangling sign rounds" },
    );
  }

  const policies = await listPolicies(db);
  const uncapped = policies
    .filter((p) => (p.mode === "allow" || p.mode === "auto") && p.spend_cap_sats === 0 && p.origin !== "cli")
    .map((p) => p.origin);
  checks.push(
    uncapped.length > 0
      ? {
        id: "caps", status: "warn",
        detail: `uncapped allow/auto origins (cap 0 = unlimited): ${uncapped.join(", ")} — set caps: bsv allow <origin> <sats>`,
      }
      : { id: "caps", status: "ok", detail: "every allow/auto origin has a spend cap" },
  );

  const reqs = await pendingRequests(db);
  if (reqs.length > 0) {
    const oldest = Math.min(...reqs.map((r) => r.created_at));
    checks.push({
      id: "requests", status: "warn",
      detail: `${reqs.length} open approval(s), oldest ${ago(oldest)} ago — review in the panel or bsv requests`,
    });
  } else {
    checks.push({ id: "requests", status: "ok", detail: "no open approvals" });
  }

  if (await db.schema.hasTable("pending_txs")) {
    const failed = await db("pending_txs").where({ status: "failed" }).select("txid");
    checks.push(
      failed.length > 0
        ? {
          id: "broadcasts", status: "warn",
          detail: `${failed.length} failed broadcast(s) — funds never moved; re-run the action`,
        }
        : { id: "broadcasts", status: "ok", detail: "no failed broadcasts" },
    );
  }

  if (jevEnabled()) {
    checks.push({ id: "jev", status: "ok", detail: "Jev advisor enabled" });
  } else if (policies.some((p) => p.mode === "auto")) {
    checks.push({
      id: "jev", status: "fail",
      detail: "auto-mode origins exist but the Jev advisor is off (no OPENROUTER_API_KEY) — every auto spend denies",
    });
  } else {
    checks.push({ id: "jev", status: "warn", detail: "Jev advisor off — requests score without advice" });
  }

  checks.push(checkPanelSync(
    path.join(os.homedir(), ".config/omarchy/plugins/bsv.wallet/Panel.qml"),
    panelSources(),
  ));

  return { ok: !checks.some((c) => c.status === "fail"), checks };
}
