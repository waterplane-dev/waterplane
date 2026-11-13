/**
 * Scenario `skills-switch`: the usual three repos, plus the skills & plugins screen and the one
 * Repo readings row that opens it (`numbers.skills`). Exists so `journey-back-lands` can tap that door.
 */
import type { DemoScenario } from "../host/index.ts";
import type { DemoModel } from "../host/model.ts";
import { firstLook } from "./first-look.ts";

export function skillsSwitch(now: number): DemoScenario {
  const base = firstLook(now);
  const model = base.state.model as unknown as DemoModel;
  return {
    ...base,
    meta: { ...base.meta, id: "skills-switch", stamp: "skills-switch-1" },
    state: { ...base.state, model: { ...model, numbers: { ...model.numbers, skills: true } } as unknown as DemoScenario["state"]["model"] },
  };
}
