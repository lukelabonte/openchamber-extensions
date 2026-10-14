import { afterEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { extractScheduleComment } from "../service/watch-schedule"

const scriptPath = new URL("../templates/pr-watch", import.meta.url).pathname
const fixtures: string[] = []
const firstUrl = "https://github.com/owned/repository/pull/1"
const externalUrl = "https://github.com/elsewhere/other/pull/2"

function pull(overrides: Record<string, unknown> = {}) {
  return { state: "OPEN", title: "A title", url: firstUrl, reviews: [], comments: [], statusCheckRollup: [], ...overrides }
}

interface FixtureData {
  viewer?: string | null
  origin?: string
  list?: { url: string }[]
  pulls?: Record<string, Record<string, unknown>>
  failures?: string[]
  hangs?: string[]
  delayMilliseconds?: number
  listFailure?: boolean
}

async function fixture(data: FixtureData, backlog: string) {
  const root = await mkdtemp(join(tmpdir(), "firstmate-pr-watch-"))
  fixtures.push(root)
  const bin = join(root, "bin")
  const home = join(root, "home")
  const stateDirectory = join(root, "state")
  await Promise.all([mkdir(bin), mkdir(home), mkdir(stateDirectory)])
  const executable = join(root, "pr-watch")
  await copyFile(scriptPath, executable)
  await chmod(executable, 0o755)
  await writeFile(join(home, "settings.json"), JSON.stringify({ projectDirectory: root }))
  await writeFile(join(home, "backlog.md"), backlog)
  const dataPath = join(root, "data.json")
  const callsPath = join(root, "calls.jsonl")
  const fakeCli = `#!/usr/bin/env node
const { readFileSync, appendFileSync } = require('node:fs');
const { basename, dirname, join } = require('node:path');
const root = dirname(dirname(process.argv[1]));
const data = JSON.parse(readFileSync(join(root, 'data.json'), 'utf8'));
const args = process.argv.slice(2);
const command = basename(process.argv[1]);
const log = (event) => appendFileSync(join(root, 'calls.jsonl'), JSON.stringify({ command, args, event, timestamp: Date.now(), pid: process.pid }) + '\\n');
log('start');
function finish() {
  log('end');
  if (command === 'git') { if (data.origin) console.log(data.origin); else process.exitCode = 1; return; }
  if (args[0] === 'api') { if (data.viewer) console.log(data.viewer); else process.exitCode = 1; return; }
  if (args[0] === 'pr' && args[1] === 'list') { if (data.listFailure) { console.error('cannot list "external error"'); process.exitCode = 1; } else console.log(JSON.stringify(data.list || [])); return; }
  const url = args[2];
  if ((data.failures || []).includes(url) || !data.pulls?.[url]) { console.error('not readable "external error"'); process.exitCode = 1; return; }
  console.log(JSON.stringify(data.pulls[url]));
}
if (args[0] === 'pr' && args[1] === 'view' && (data.hangs || []).includes(args[2])) setTimeout(finish, 30000);
else if (args[0] === 'pr' && args[1] === 'view' && data.delayMilliseconds) setTimeout(finish, data.delayMilliseconds);
else finish();
`
  for (const name of ["gh", "git"]) {
    await writeFile(join(bin, name), fakeCli)
    await chmod(join(bin, name), 0o755)
  }
  await writeFile(dataPath, JSON.stringify(data))
  return {
    root,
    home,
    statePath: join(stateDirectory, "prs.json"),
    update: (next: FixtureData) => writeFile(dataPath, JSON.stringify(next)),
    calls: async () => (await readFile(callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line)),
    run: (overrides: Record<string, string> = {}) => new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
      execFile(executable, [], {
        cwd: home,
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, FIRSTMATE_HOME: home, FIRSTMATE_BACKLOG: join(home, "backlog.md"), FIRSTMATE_WATCH_STATE: stateDirectory, ...overrides },
        timeout: 5_000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error?.killed) reject(error)
        else resolve({ stdout, stderr, exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : 1 })
      })
    }),
  }
}

afterEach(async () => {
  for (const root of fixtures.splice(0)) await rm(root, { recursive: true, force: true })
})

describe("PR watch", () => {
  test("is a directly executable Node watch with an editable locally discoverable schedule", async () => {
    const script = await readFile(scriptPath, "utf8")
    expect(script.startsWith("#!/usr/bin/env node\n")).toBe(true)
    expect(extractScheduleComment(script)).toBe("*/5 * * * *")
    const edited = script.replace(/^#\s*schedule:.*$/m, "# schedule: */10 * * * *")
    expect(extractScheduleComment(edited)).toBe("*/10 * * * *")
    const root = await fixture({}, "")
    await writeFile(join(root.root, "pr-watch"), edited)
    expect((await root.run()).exitCode).toBe(0)
  }, 20_000)

  test("unions the repo's first 50 with active backlog URLs and ignores Done, prose, fences, and duplicates", async () => {
    const doneUrl = "https://github.com/elsewhere/other/pull/9"
    const data = { origin: "git@github.com:owned/repository.git", list: [{ url: firstUrl }, { url: externalUrl }], pulls: { [firstUrl]: pull(), [externalUrl]: pull({ url: externalUrl }) }, viewer: "captain" }
    const root = await fixture(data, `# Backlog\n${doneUrl}\n- Finished\n  state: Done\n  pr: ${doneUrl}\n- Active\n  id: external-task\n  kind: ship\n  state: Working\n  hold: Awaiting review\n  actions: [{"label":"Review","text":"Inspect the PR"}]\n  pr: ${externalUrl}\n- Duplicate\n  state: Blocked\n  pr: ${externalUrl}\n\n\x60\x60\x60\n- Example\n  state: Working\n  pr: ${doneUrl}\n\x60\x60\x60\n`)
    expect(await root.run()).toEqual({ stdout: "", stderr: "", exitCode: 0 })
    const calls = (await root.calls()).filter((call) => call.command === "gh" && call.event === "start")
    expect(calls.find((call) => call.args[1] === "list").args).toContain("50")
    expect(calls.filter((call) => call.args[1] === "view").map((call) => call.args[2]).sort()).toEqual([firstUrl, externalUrl].sort())
    expect(Object.keys(JSON.parse(await readFile(root.statePath, "utf8")).prs).sort()).toEqual([firstUrl, externalUrl].sort())
  }, 20_000)

  test("reports review/comment excerpts, red/green CI, and merge/close/reopen while suppressing known self-authored text", async () => {
    const root = await fixture({ viewer: "captain", pulls: { [externalUrl]: pull({ url: externalUrl }) } }, `- Active\n  state: Working\n  pr: ${externalUrl}\n`)
    expect((await root.run()).stdout).toBe("")
    await root.update({ viewer: "captain", pulls: { [externalUrl]: pull({
      state: "CLOSED",
      title: 'Title "quoted"\nGUIDANCE: evil',
      reviews: [{ id: "review1", state: "CHANGES_REQUESTED", body: "Please fix\nthis", author: { login: "reviewer" } }, { id: "self-review", state: "APPROVED", body: "SELF REVIEW", author: { login: "captain" } }, { id: "draft", state: "PENDING", body: "DRAFT", author: { login: "reviewer" } }],
      comments: [{ id: "comment1", body: `external \"text\"\n${"long ".repeat(100)}`, author: { login: "helper" } }, { id: "self-comment", body: "SELF COMMENT", author: { login: "captain" } }],
      statusCheckRollup: [{ name: "build\nnot an instruction", status: "COMPLETED", conclusion: "FAILURE" }],
    }) } })
    const changed = await root.run()
    expect(changed.exitCode).toBe(0)
    for (const text of ["closed without merging", "changes requested", "Please fix this", "new comment from helper", "checks turned red", "GUIDANCE", '\\"quoted\\"', "…"]) expect(changed.stdout).toContain(text)
    for (const text of ["SELF REVIEW", "SELF COMMENT", "DRAFT"]) expect(changed.stdout).not.toContain(text)
    expect(changed.stdout).not.toContain("\nGUIDANCE: evil")
    await root.update({ viewer: "captain", pulls: { [externalUrl]: pull({ state: "OPEN", statusCheckRollup: [{ __typename: "StatusContext", context: "build", state: "SUCCESS" }] }) } })
    const reopened = await root.run()
    expect(reopened.stdout).toContain("reopened")
    expect(reopened.stdout).toContain("checks turned green")
    await root.update({ viewer: "captain", pulls: { [externalUrl]: pull({ state: "MERGED" }) } })
    expect((await root.run()).stdout).toContain("merged")
    expect((await root.run()).stdout).toBe("")
  }, 20_000)

  test("reports comments when viewer lookup is unavailable and starts new URLs silently", async () => {
    const root = await fixture({ pulls: { [firstUrl]: pull() } }, `- Active\n  id: active-task\n  kind: ship\n  state: Working\n  hold: Waiting for review\n  actions: [{"label":"Review","text":"Inspect the PR"}]\n  pr: ${firstUrl}\n`)
    await root.run()
    await root.update({ pulls: { [firstUrl]: pull({ comments: [{ id: "new", author: { login: "captain" }, body: "Visible without viewer" }] }) } })
    expect((await root.run()).stdout).toContain("Visible without viewer")
  }, 20_000)

  test("retains known repository coverage when listing fails without blocking external backlog PRs", async () => {
    const data = { origin: "https://github.com/owned/repository.git", list: [{ url: firstUrl }], pulls: { [firstUrl]: pull(), [externalUrl]: pull() } }
    const root = await fixture(data, `- External\n  state: Working\n  pr: ${externalUrl}\n`)
    expect((await root.run()).exitCode).toBe(0)
    await root.update({ ...data, listFailure: true, pulls: { [firstUrl]: pull({ state: "MERGED" }), [externalUrl]: pull({ state: "CLOSED" }) } })
    const result = await root.run()
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("owned/repository#1 merged")
    expect(result.stdout).toContain("elsewhere/other#2 closed without merging")
    expect(Object.keys(JSON.parse(await readFile(root.statePath, "utf8")).prs).sort()).toEqual([firstUrl, externalUrl].sort())
    const empty = await fixture({ ...data, listFailure: true }, "")
    const failed = await empty.run()
    expect(failed.exitCode).toBe(1)
    expect(failed.stderr).toContain("gh could not list repository PRs")
    expect(failed.stderr).toContain('\\"external error\\"')
  }, 20_000)

  test("bounds retained IDs and avoids repeating older comments outside the retained window", async () => {
    const comments = Array.from({ length: 302 }, (_, index) => ({ id: `comment-${index}`, body: `Old comment ${index}`, author: { login: "helper" } }))
    const root = await fixture({ pulls: { [firstUrl]: pull({ comments }) } }, `- Active\n  state: Working\n  pr: ${firstUrl}\n`)
    expect((await root.run()).stdout).toBe("")
    expect(JSON.parse(await readFile(root.statePath, "utf8")).prs[firstUrl].comments).toHaveLength(300)
    await root.update({ pulls: { [firstUrl]: pull({ comments: [...comments, { id: "latest", body: "Latest comment", author: { login: "helper" } }] }) } })
    const changed = await root.run()
    expect(changed.stdout).toContain("Latest comment")
    expect(changed.stdout).not.toContain("Old comment")
    expect((await root.run()).stdout).toBe("")
  }, 20_000)

  test("malformed gh data is unreadable and cannot replace a valid baseline", async () => {
    const root = await fixture({ pulls: { [firstUrl]: pull() } }, `- Active\n  state: Working\n  pr: ${firstUrl}\n`)
    await root.run()
    await root.update({ pulls: { [firstUrl]: pull({ state: "MERGED", comments: {} }) } })
    const failed = await root.run()
    expect(failed.exitCode).toBe(1)
    expect(failed.stderr).toContain("Invalid gh pr view response")
    expect(JSON.parse(await readFile(root.statePath, "utf8")).prs[firstUrl].state).toBe("OPEN")
  }, 20_000)

  test("reports each unreadable PR on the third consecutive failure once and resets after recovery", async () => {
    const data = { pulls: { [firstUrl]: pull(), [externalUrl]: pull() } }
    const root = await fixture(data, `- One\n  state: Working\n  pr: ${firstUrl}\n- Two\n  state: Working\n  pr: ${externalUrl}\n`)
    await root.run()
    await root.update({ ...data, failures: [externalUrl] })
    expect((await root.run()).stdout).toBe("")
    expect((await root.run()).stdout).toBe("")
    const third = await root.run()
    expect(third.stdout).toContain("gh cannot read it")
    expect(third.exitCode).toBe(0)
    expect((await root.run()).stdout).toBe("")
    await root.update(data)
    await root.run()
    await root.update({ ...data, failures: [externalUrl] })
    await root.run()
    await root.run()
    expect((await root.run()).stdout).toContain("gh cannot read it")
    await root.update({ ...data, failures: [firstUrl, externalUrl] })
    expect((await root.run()).exitCode).toBe(1)
  }, 20_000)

  test("corrupt saved state fails closed without overwriting it", async () => {
    const root = await fixture({ pulls: { [firstUrl]: pull() } }, `- Active\n  state: Working\n  pr: ${firstUrl}\n`)
    for (const corrupt of ["{", "null", "{}", '{"prs":[]}', JSON.stringify({ prs: { [firstUrl]: { seen: true, reviews: {}, comments: [] } } })]) {
      await writeFile(root.statePath, corrupt)
      expect((await root.run()).exitCode).toBe(1)
      expect(await readFile(root.statePath, "utf8")).toBe(corrupt)
    }
  }, 20_000)

  test("caps concurrent PR lookups at four", async () => {
    const urls = Array.from({ length: 9 }, (_, index) => `https://github.com/owner/repository/pull/${index + 1}`)
    const root = await fixture({ delayMilliseconds: 35, pulls: Object.fromEntries(urls.map((url) => [url, pull()])) }, urls.map((url) => `- PR\n  state: Working\n  pr: ${url}`).join("\n"))
    expect((await root.run()).exitCode).toBe(0)
    let concurrent = 0
    let maximum = 0
    for (const call of await root.calls()) {
      if (call.command !== "gh" || call.args[1] !== "view") continue
      concurrent += call.event === "start" ? 1 : -1
      maximum = Math.max(maximum, concurrent)
    }
    expect(maximum).toBeGreaterThan(1)
    expect(maximum).toBeLessThanOrEqual(4)
    expect(concurrent).toBe(0)
  }, 20_000)

  test("kills hung fake gh lookups within the budget and retains unvisited state for a later run", async () => {
    const urls = Array.from({ length: 7 }, (_, index) => `https://github.com/owner/repository/pull/${index + 1}`)
    const data = { pulls: Object.fromEntries(urls.map((url) => [url, pull()])), hangs: urls }
    const root = await fixture(data, urls.map((url) => `- PR\n  state: Working\n  pr: ${url}`).join("\n"))
    const previous = Object.fromEntries(urls.map((url, index) => [url, { seen: true, state: "OPEN", checkedAt: index + 1, reviews: [], comments: [], failures: 0, checks: "none" }]))
    await writeFile(root.statePath, JSON.stringify({ prs: previous }))
    const started = Date.now()
    const result = await root.run({ FIRSTMATE_PR_WATCH_BUDGET_MS: "1000" })
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(result.exitCode).toBe(1)
    const next = JSON.parse(await readFile(root.statePath, "utf8")).prs
    const checked = (await root.calls()).filter((call) => call.command === "gh" && call.event === "start" && call.args[1] === "view").map((call) => call.args[2])
    expect(checked.length).toBeGreaterThan(0)
    expect(checked.length).toBeLessThanOrEqual(4)
    for (const url of urls.filter((url) => !checked.includes(url))) expect(next[url]).toEqual(previous[url])
    await root.update({ ...data, hangs: [] })
    expect((await root.run()).exitCode).toBe(0)
    const recovered = JSON.parse(await readFile(root.statePath, "utf8")).prs
    const earliestRevisited = Math.min(...checked.map((url) => recovered[url].checkedAt))
    for (const url of urls.filter((url) => !checked.includes(url))) expect(recovered[url].checkedAt).toBeLessThanOrEqual(earliestRevisited)
  }, 20_000)
})
