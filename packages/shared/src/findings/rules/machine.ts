/** Machine-scope rules (PLAN §4): this desktop's own files, settings, ledger and checklist. */
import { weekSavingOf } from "../saving.js";
import { fmtCount } from "../../tokens.js";
import { fmtUsd } from "../../pricing.js";
import type { FindingRemedy, FindingSaving, FindingsResult } from "../types.js";
import { Acc, FILES_ONLY, type FindingFacts } from "./facts.js";
import { leversOf, modelOf, perRequestMove, type Insight } from "./insights.js";

const tokensBox = (box: "cold" | "writes" | "agents" | "top" | "models" | "requests") => ({ screen: "tokens" as const, box });

export function machineRules(f: FindingFacts): FindingsResult {
  const a = new Acc(f, "machine");

  // global instructions
  {
    const rule = "global-instructions";
    const g = f.globalInstructions;
    if (!g) a.skip(rule, "this desktop's always-on files were not read");
    else if (g.chars <= g.warnChars) a.pass("machine.global-instructions", rule, `This desktop's always-on files are ${fmtCount(g.chars)} characters, under the ${fmtCount(g.warnChars)} line.`, FILES_ONLY);
    else if (!a.blind(rule)) {
      const s = f.points ? weekSavingOf(f.points, { now: f.now, extraChars: g.chars - g.warnChars }) : null;
      const saving: FindingSaving | undefined = s && !("absent" in s) ? s : undefined;
      a.find({ id: "machine.global-instructions", rule, kind: "cost", weight: "consider", what: `This desktop's always-on files are ${fmtCount(g.chars)} characters, over the ${fmtCount(g.warnChars)} line, and ride on every session in every repo.`, evidence: { screen: "alwayson" }, ...(saving ? { saving } : {}), remedy: { kind: "seed", prompt: "groom-global", facts: { warnChars: g.warnChars } }, waveVia: "ignore" });
    }
  }

  // skills unused
  {
    const rule = "skills-unused";
    const sk = f.skills?.filter((s) => s.level === "user");
    if (!sk) a.skip(rule, "the skill inventory was not read");
    else if (!sk.some((s) => s.usesEverywhere)) a.skip(rule, "no skill has a use count yet");
    else if (!a.blind(rule)) {
      const unused = sk.filter((s) => s.usesEverywhere && s.usesEverywhere.d30 === 0 && (s.listingChars ?? 0) > 0);
      if (!unused.length) a.pass("machine.skills-unused", rule, "Every user-level skill was used in the last 30 days.");
      else {
        const chars = unused.reduce((n, s) => n + (s.listingChars ?? 0), 0);
        const s = f.points ? weekSavingOf(f.points, { now: f.now, extraChars: chars }) : null;
        a.find({ id: "machine.skills-unused", rule, kind: "cost", weight: "consider", what: `${unused.length} user-level skill${unused.length === 1 ? "" : "s"} unused in 30 days, ${fmtCount(chars)} characters of description on every request.`, evidence: { screen: "skills", ids: unused.map((u) => u.id) }, ...(s && !("absent" in s) ? { saving: s } : {}), remedy: { kind: "door", route: { screen: "skills", ids: unused.map((u) => u.id) } }, waveVia: "ignore" });
      }
    }
  }

  // permissions + auto-compact
  {
    if (!f.permissions) a.skip("permissions-broad", "the permission files were not read");
    else {
      const broad = f.permissions.filter((p) => p.source === "user" && p.notes.some((n) => n.startsWith("Allows all of")));
      if (!broad.length) a.pass("machine.permissions-broad", "permissions-broad", "No allow rule in your user settings opens a whole tool.", FILES_ONLY);
      else a.find({ backends: FILES_ONLY, id: "machine.permissions-broad", rule: "permissions-broad", kind: "quality", weight: "consider", what: `${broad.length} allow rule${broad.length === 1 ? "" : "s"} in your user settings open a whole tool: ${broad.map((p) => p.rule).join(", ")}.`, evidence: { screen: "permissions", ruleKeys: broad.map((p) => `${p.list}:${p.rule}`) }, remedy: { kind: "howto", text: "Narrow each rule, or move it to ask." }, waveVia: "ignore" });
    }
    // Decision 4: the machine finding speaks for the user-level setting (or none anywhere), once; a repo's own override is that repo's finding.
    // Only the desktop's own reading counts: a repo's reading standing in would pass (or hide) what the
    // user-level setting does. A source with no machine reading is "not checked", never a pass.
    const ac = f.autoCompact?.machine;
    if (!ac) a.skip("auto-compact", "where this desktop decides auto-compact was not read");
    else if (ac.status === "pass") a.pass("machine.auto-compact", "auto-compact", "Auto-compact is set where this desktop decides it, to an acceptable size.", FILES_ONLY);
    else if (ac.source !== "user" && ac.source !== "unset" && ac.source !== "env") a.skip("auto-compact", "this desktop's auto-compact is decided in a repo's own settings, which that repo's check judges");
    else a.find({ backends: FILES_ONLY, id: "machine.auto-compact", rule: "auto-compact", kind: "quality", weight: "consider", what: `Auto-compact is ${ac.source === "unset" ? "not set anywhere" : ac.source === "env" ? "set in this desktop's environment" : "set in your user settings"} and lets a conversation grow expensive.`, evidence: null, remedy: { kind: "howto", text: "Settings, Sessions: choose an auto-compact size." }, waveVia: "ignore" });
  }

  // cost levers from the ledger
  {
    const x = f.ledger;
    const rules: [Insight["id"], string, Parameters<typeof tokensBox>[0]][] = [
      ["cold", "cold-cache", "cold"], ["writes", "cache-writes", "writes"], ["agents", "subagent-share", "agents"],
      ["concentration", "concentration", "top"], ["model", "model-mix", "models"], ["trend", "request-trend", "requests"],
    ];
    if (!x || x.usd <= 0 || x.tok <= 0) { for (const [, r] of rules) a.skip(r, "the token ledger has nothing priced to read yet"); }
    else if (a.backends.understood.length === 0) { for (const [, r] of rules) a.blind(r); }
    else {
      const found = new Map<string, Insight>();
      for (const i of leversOf(x)) found.set(i.id, i);
      const m = modelOf(x);
      if (m) { const { label: _l, ...i } = m; found.set("model", i); }
      if (f.trend) {
        const mv = perRequestMove(f.trend.cur, f.trend.prev);
        if (mv && mv.ch > 0) found.set("trend", { id: "trend", head: `A request costs ${mv.ch}% more than the week before`, body: `${fmtUsd(mv.perA)} per request over the last 7 days against ${fmtUsd(mv.perB)} the 7 before.`, tryThis: "Longer conversations or a dearer model are the usual cause." });
      }
      for (const [iid, rule, box] of rules) {
        if (iid === "cold" && x.cold === null) { a.skip(rule, "this ledger does not measure what the gaps cost"); continue; }
        if (iid === "trend" && !f.trend) { a.skip(rule, "no two weeks to compare"); continue; }
        // Too thin to judge is not "fine": the same floors `perRequestMove` and `leversOf` use, said as not checked.
        if (iid === "trend" && f.trend && (f.trend.cur.turns < 20 || f.trend.prev.turns < 20 || f.trend.cur.usd <= 0 || f.trend.prev.usd <= 0)) { a.skip(rule, "fewer than 20 requests in one of the last two weeks, too few to compare"); continue; }
        if (iid === "concentration" && (x.topUsd.length < 3 || x.conversations <= 20)) { a.skip(rule, "20 conversations or fewer in the ledger, too few to say whether a few carry the cost"); continue; }
        const i = found.get(iid);
        const id = `machine.${rule}`;
        if (!i) { a.pass(id, rule, passText(iid)); continue; }
        const remedy: FindingRemedy = iid === "concentration" ? { kind: "door", route: { screen: "tokens", box: "top" } } : { kind: "howto", text: i.tryThis ?? i.body };
        a.find({ id, rule, kind: "cost", weight: "consider", what: `${i.head}. ${i.body}`, evidence: tokensBox(box), remedy, waveVia: "ignore" });
      }
    }
  }

  // the desktop's own checklist
  {
    if (!f.hostChecks) { a.skip("price-list", "this desktop's checklist was not read"); }
    for (const c of f.hostChecks ?? []) {
      const isPrice = c.id.includes("price");
      const rule = isPrice ? "price-list" : `install.${c.id}`, id = `machine.${rule}`;
      if (c.status === "pass") { a.pass(id, rule, `${c.label}: ${c.detail}`, FILES_ONLY); continue; }
      a.find({ backends: FILES_ONLY, id, rule, kind: isPrice ? "quality" : "install", weight: "finding", what: `${c.label}: ${c.detail}`, evidence: null, remedy: c.fix ? { kind: "fix", fixId: c.fix } : { kind: "howto", text: c.detail }, waveVia: "none" });
    }
  }
  return a.out;
}

function passText(id: Insight["id"]): string {
  switch (id) {
    case "cold": return "Expired caches cost under 2% of the spend.";
    case "writes": return "Cache writes are not out of proportion to the tokens they carry.";
    case "agents": return "Subagents are under 15% of the cost.";
    case "concentration": return "No handful of conversations carries the cost.";
    case "model": return "No one model's cost outruns its share of the tokens.";
    default: return "A request costs about what it did the week before.";
  }
}
