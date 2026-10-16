/**
 * The code root with the knob unset: the first usual folder that exists (a repo-holding one beats
 * an empty one), else `~/dev`. Injected fakes — no disk.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BRAND } from "@waterplane/shared";
import { CODE_FOLDERS, pickCodeRoot, resolveRoot, wslMountPath } from "../dist/branddirs.js";
import { checkRoot } from "../dist/doctor.js";

const P = BRAND.envPrefix;
/** dirs: paths that exist; repos: those among them holding a checkout. */
const fake = (dirs, repos = []) => ({ isDir: (p) => dirs.includes(p), hasGitChild: (p) => repos.includes(p) });

test("coderoot: the knob wins and nothing is looked at", () => {
  const r = resolveRoot({ [`${P}ROOT`]: "/work" }, "/h", fake(["/h/code"], ["/h/code"]));
  assert.deepEqual(r, { root: "/work", defaulted: false, picked: "named", tried: [] });
});

test("coderoot: under WSL a Windows-style root is its /mnt mount (the .env both sides share)", () => {
  assert.equal(wslMountPath("c:/dev"), "/mnt/c/dev");
  assert.equal(wslMountPath("C:\\Users\\me\\code\\"), "/mnt/c/Users/me/code");
  assert.equal(wslMountPath("D:"), "/mnt/d");
  assert.equal(wslMountPath("/home/me/dev"), "/home/me/dev");
  assert.equal(wslMountPath("~/dev"), "~/dev");
  if (process.platform === "win32") return;   // resolve() below is POSIX
  const named = resolveRoot({ [`${P}ROOT`]: "c:/dev" }, "/h", fake([]), undefined, true);
  assert.deepEqual(named, { root: "/mnt/c/dev", defaulted: false, picked: "named", tried: [] });
  assert.equal(resolveRoot({}, "/h", fake([]), "D:\\src", true).root, "/mnt/d/src");
  // Outside WSL the path is left alone (macOS/Linux never see a drive letter for real).
  assert.notEqual(resolveRoot({ [`${P}ROOT`]: "c:/dev" }, "/h", fake([]), undefined, false).root, "/mnt/c/dev");
});

test("coderoot: the first existing folder in the documented order", () => {
  assert.deepEqual(CODE_FOLDERS.slice(0, 3), ["dev", "code", "Code"]);
  const r = pickCodeRoot("/h", fake(["/h/projects", "/h/src", "/h/Documents/GitHub"]), "linux");
  assert.equal(r.root, "/h/src");
  assert.equal(r.picked, "found");
  assert.equal(r.tried[0], "/h/dev");
  assert.equal(r.tried.at(-1), "/h/Documents/GitHub");
});

test("coderoot: a folder holding a repo beats an earlier empty one", () => {
  const r = pickCodeRoot("/h", fake(["/h/dev", "/h/source/repos"], ["/h/source/repos"]));
  assert.equal(r.root, "/h/source/repos");
  assert.equal(pickCodeRoot("/h", fake(["/h/dev", "/h/src"], ["/h/dev", "/h/src"])).root, "/h/dev", "ties keep the order");
});

test("coderoot: none exist -> ~/dev, still defaulted, as a fallback", () => {
  const r = resolveRoot({}, "/home/sam", fake([]));
  assert.equal(r.root, "/home/sam/dev");
  assert.equal(r.defaulted, true);
  assert.equal(r.picked, "fallback");
  assert.equal(r.tried[0], "/home/sam/dev");
});

test("coderoot: the walk stops at the first folder holding a repo", () => {
  const seen = [];
  const fs = { isDir: (p) => (seen.push(p), true), hasGitChild: (p) => p === "/h/dev" };
  assert.equal(pickCodeRoot("/h", fs, "linux").root, "/h/dev");
  assert.deepEqual(seen, ["/h/dev"], "a populated ~/dev touches nothing else");
});

test("coderoot: macOS never touches ~/Documents (a privacy prompt for a daemon)", () => {
  const r = pickCodeRoot("/Users/sam", fake(["/Users/sam/Documents/GitHub"], ["/Users/sam/Documents/GitHub"]), "darwin");
  assert.equal(r.picked, "fallback");
  assert.ok(!r.tried.some((t) => t.includes("Documents")));
  assert.equal(pickCodeRoot("/home/sam", fake(["/home/sam/Documents/GitHub"]), "linux").root, "/home/sam/Documents/GitHub");
});

test("coderoot: a Windows-style home works", () => {
  const home = "C:\\Users\\Johan";
  const r = pickCodeRoot(home, fake([`${home}/source/repos`]));
  assert.equal(r.root, `${home}/source/repos`);
  assert.equal(pickCodeRoot(`${home}\\`, fake([`${home}/code`])).root, `${home}/code`, "trailing separator stripped");
  assert.equal(pickCodeRoot(home, fake([])).root, `${home}/dev`);
});

test("coderoot: the doctor says a found root was derived, and leads the missing case with mkdir", () => {
  const c = checkRoot(process.cwd(), true, "found");
  assert.equal(c.status, "ok");
  assert.match(c.detail, new RegExp(`${P}ROOT unset — first usual code folder that exists`));
  const m = checkRoot("/nowhere/dev", true, "fallback");
  assert.equal(m.status, "fail");
  assert.match(m.fix, /^Create \/nowhere\/dev and clone .*mkdir \/nowhere\/dev.*service install --force/s);
});
