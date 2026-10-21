#!/usr/bin/env node

// service/cleanup-pr-links.ts
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path2 from "node:path";
import { pathToFileURL } from "node:url";

// service/desktop-proxy.ts
async function callDesktopProxy(input) {
  if (input.support.kind === "unsupported") {
    return { kind: "unsupported", reason: input.support.reason };
  }
  const url = `http://127.0.0.1:${input.support.port}${input.path}`;
  const headers = {};
  if (input.body !== undefined)
    headers["content-type"] = "application/json";
  if (input.support.token !== undefined)
    headers.authorization = `Bearer ${input.support.token}`;
  try {
    const result = await input.fetcher(url, { method: input.method, headers, ...input.body !== undefined ? { body: input.body } : {} });
    if (result.status >= 200 && result.status < 300) {
      try {
        return { kind: "ok", text: await result.text() };
      } catch {
        return { kind: "ok" };
      }
    }
    if (result.status === 401 || result.status === 403) {
      return {
        kind: "unsupported",
        reason: `the ${input.label} call was rejected with status ${result.status}: this host requires credentials that were not offered`
      };
    }
    return { kind: "failed", message: `the ${input.label} call answered with status ${result.status}` };
  } catch (error) {
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

// service/interrupt.ts
async function discoverSupport(input) {
  let raw;
  try {
    raw = await input.filesystem.readFile(input.settingsPath);
  } catch {
    return { kind: "unsupported", reason: `the OpenChamber settings file could not be read (${input.settingsPath})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unsupported", reason: "the OpenChamber settings file is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "unsupported", reason: "the OpenChamber settings file is not a JSON object" };
  }
  const record = parsed;
  const port = record.desktopLocalPort;
  const token = record.desktopLocalClientToken;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) {
    return { kind: "unsupported", reason: "the OpenChamber settings file has no usable desktopLocalPort" };
  }
  const usableToken = typeof token === "string" && token !== "" ? token : undefined;
  if (token !== undefined && usableToken === undefined) {
    return { kind: "unsupported", reason: "the OpenChamber settings file has a non-string desktopLocalClientToken" };
  }
  return { kind: "supported", port, ...usableToken !== undefined ? { token: usableToken } : {} };
}

// service/settings.ts
var defaultSettings = {
  coordinatorModel: "",
  coordinatorVariant: "",
  workerModel: "",
  workerVariant: "",
  refreshSeconds: 30
};
var settingNames = new Set(Object.keys(defaultSettings));

// service/slug.ts
import path from "node:path";
function normalizeProjectDirectory(projectDirectory) {
  return path.resolve(projectDirectory.trim());
}

// service/provision.ts
var legacyTemplateHashes = {
  charter: ["44c30fc03a72d0e3db47f520f77e9d2f256a8595da0c4a92a3613ba8d0bf4bd9", "f2a01f5f4d7e76a63bd026ebda14ecceee56c266aa2c8547af3e8b1430bf7c5b", "26ec3644f04dd682108b932ce183734b3dcaf9bba607c402da7adfde985d5d3b", "8a888fd9dd86efbd7f7bfb35a3780353c7ec690c83c8dbf7cec007c7b5447b4a"],
  "pr-watch": ["436ce74feaf4fcb7beaeca787e30b0434ed2a5feeb0e4222540852c6b103fbbe"]
};
var sharedFiles = [
  { templateName: "charter.md", fileName: "charter.md", legacyHashes: legacyTemplateHashes.charter },
  { templateName: "captain.md", fileName: "captain.md" },
  { templateName: "watches-README.md", fileName: "watches/README.md" },
  { templateName: "pr-watch", fileName: "watches/pr-watch", executable: true, legacyHashes: legacyTemplateHashes["pr-watch"] }
];

// service/registry.ts
class RegistryCorruptError extends Error {
  constructor(filePath, cause) {
    super(`FirstMate registry file ${filePath} is unreadable (${cause}). Fix or delete it, then relaunch.`);
    this.name = "RegistryCorruptError";
  }
}
function registryPath(homeRoot) {
  return `${homeRoot}/registry.json`;
}
async function loadRegistry(filesystem, homeRoot) {
  const filePath = registryPath(homeRoot);
  if (!await filesystem.exists(filePath)) {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(await filesystem.readFile(filePath));
  } catch (error) {
    throw new RegistryCorruptError(filePath, error instanceof Error ? error.message : "not valid JSON");
  }
  if (!isPlainObject(parsed)) {
    throw new RegistryCorruptError(filePath, "not a JSON object");
  }
  for (const [slug, registration] of Object.entries(parsed)) {
    if (!isRegistration(registration)) {
      throw new RegistryCorruptError(filePath, `the entry for slug ${slug} is not a registration`);
    }
  }
  return parsed;
}
function isRegistration(value) {
  if (!isPlainObject(value))
    return false;
  return typeof value.slug === "string" && typeof value.projectDirectory === "string" && typeof value.homeDirectory === "string" && typeof value.coordinatorSessionId === "string" && typeof value.createdAt === "string";
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// service/launch.ts
var lifecycleInFlight = new Map;
function resolveProjectHomeDirectory(homeRoot, slug) {
  if (typeof slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
    throw new Error("invalid FirstMate project slug");
  return `${normalizeProjectDirectory(homeRoot)}/projects/${slug}`;
}

// service/archive.ts
function archivePath(homeRoot, slug) {
  return `${homeRoot}/projects/${slug}/reports/archive.jsonl`;
}
async function loadHostArchivedSessionIds(filesystem, homeRoot, slug) {
  return loadSessionIds(filesystem, homeRoot, slug, true);
}
async function loadSessionIds(filesystem, homeRoot, slug, hostOnly) {
  const filePath = archivePath(homeRoot, slug);
  if (!await filesystem.exists(filePath))
    return new Set;
  const ids = new Set;
  for (const line of (await filesystem.readFile(filePath)).split(`
`)) {
    const trimmed = line.trim();
    if (trimmed === "")
      continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isArchiveEntry(parsed) && (!hostOnly || parsed.hostArchived === true))
        ids.add(parsed.sessionId);
    } catch {}
  }
  return ids;
}
function isArchiveEntry(value) {
  return typeof value === "object" && value !== null && typeof value.sessionId === "string" && typeof value.title === "string" && typeof value.archivedAt === "string";
}

// service/backlog.ts
var backlogStates = [
  "Queued",
  "Working",
  "Blocked",
  "Parked",
  "Done",
  "Failed",
  "Idle"
];
var fieldKeys = {
  id: "id",
  kind: "kind",
  "blocked-by": "blockedBy",
  hold: "hold",
  "review-head": "reviewHead",
  actions: "actions",
  session: "sessionId",
  "archive-session": "archiveSessionId",
  worktree: "worktreeDirectory",
  branch: "branch",
  "start-ref": "startRef",
  pr: "prUrl",
  created: "createdAt",
  updated: "updatedAt"
};
var allFieldKeys = new Set(["state", ...Object.keys(fieldKeys)]);
var timestampFields = ["createdAt", "updatedAt"];
function parseBacklog(markdown) {
  const tasks = [];
  const errors = [];
  const taskIds = new Set;
  let entry;
  let inCodeFence = false;
  const closeEntry = () => {
    if (entry === undefined)
      return;
    const draft = entry;
    entry = undefined;
    if (draft.problem !== undefined) {
      errors.push(draft.problem);
      return;
    }
    const { state, ...optionalFields } = draft.fields;
    if (state === undefined) {
      errors.push({ line: draft.titleLine, message: `the entry "${draft.title}" has no state line` });
      return;
    }
    if (optionalFields.id !== undefined) {
      if (taskIds.has(optionalFields.id)) {
        errors.push({ line: draft.idLine ?? draft.titleLine, message: `the entry "${draft.title}" repeats the task id "${optionalFields.id}"` });
        return;
      }
      taskIds.add(optionalFields.id);
    }
    tasks.push({ title: draft.title, ...optionalFields, state });
  };
  markdown.split(`
`).forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inCodeFence = !inCodeFence;
      return;
    }
    if (inCodeFence || trimmed === "")
      return;
    const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
    if (bullet !== null) {
      closeEntry();
      entry = { titleLine: lineNumber, title: bullet[1].trim(), fields: {} };
      return;
    }
    if (trimmed.startsWith("#")) {
      closeEntry();
      return;
    }
    const field = /^([A-Za-z][A-Za-z-]*):\s*(.*)$/.exec(trimmed);
    const indented = line.startsWith(" ") || line.startsWith("\t");
    if (!indented) {
      closeEntry();
      return;
    }
    if (entry === undefined) {
      if (field !== null && allFieldKeys.has(field[1])) {
        errors.push({ line: lineNumber, message: `the field "${field[1]}" has no entry above it` });
      }
      return;
    }
    applyField(entry, field, lineNumber);
  });
  closeEntry();
  return { tasks, errors };
}
function applyField(entry, field, lineNumber) {
  if (entry.problem !== undefined)
    return;
  if (field === null) {
    entry.problem = {
      line: lineNumber,
      message: `the entry "${entry.title}" has a line that is not a \`key: value\` field`
    };
    return;
  }
  const key = field[1];
  const value = field[2].trim();
  if (key === "state") {
    if (!isBacklogState(value)) {
      entry.problem = { line: lineNumber, message: `the entry "${entry.title}" has an unknown state "${value}"` };
    } else if (entry.fields.state !== undefined) {
      entry.problem = { line: lineNumber, message: `the entry "${entry.title}" repeats the "state" field` };
    } else {
      entry.fields.state = value;
    }
    return;
  }
  const fieldName = fieldKeys[key];
  if (fieldName === undefined) {
    entry.problem = { line: lineNumber, message: `the entry "${entry.title}" has an unknown field "${key}"` };
    return;
  }
  if (entry.fields[fieldName] !== undefined) {
    entry.problem = { line: lineNumber, message: `the entry "${entry.title}" repeats the "${key}" field` };
    return;
  }
  if (fieldName === "actions") {
    const actions = parseTaskActions(value);
    if (actions === undefined) {
      entry.problem = { line: lineNumber, message: `the entry "${entry.title}" has an invalid "actions" field; use up to four unique nonempty labels and prompts separated by "=>" and "|", escaping pipes and backslashes` };
    } else {
      entry.fields.actions = actions;
    }
    return;
  }
  if (value === "") {
    entry.problem = { line: lineNumber, message: `the entry "${entry.title}" has an empty "${key}" field` };
    return;
  }
  if (timestampFields.includes(fieldName) && Number.isNaN(Date.parse(value))) {
    entry.problem = { line: lineNumber, message: `the entry "${entry.title}" has a "${key}" that is not a timestamp` };
    return;
  }
  if (fieldName === "kind") {
    if (!isTaskKind(value)) {
      entry.problem = { line: lineNumber, message: `the entry "${entry.title}" has an unknown "kind" value "${value}"` };
    } else {
      entry.fields.kind = value;
    }
    return;
  }
  if ((fieldName === "id" || fieldName === "blockedBy") && !isTaskId(value)) {
    entry.problem = { line: lineNumber, message: `the entry "${entry.title}" has a "${key}" that is not a path-safe task id (1–64 lowercase letters, digits or hyphens, starting with a letter or digit)` };
    return;
  }
  if (fieldName === "reviewHead" && !isReviewHead(value)) {
    entry.problem = { line: lineNumber, message: `the entry "${entry.title}" has a "${key}" that is not a hex SHA (7–64 characters)` };
    return;
  }
  if (fieldName === "archiveSessionId" && !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    entry.problem = { line: lineNumber, message: `the entry "${entry.title}" has an invalid "archive-session" session id` };
    return;
  }
  entry.fields[fieldName] = value;
  if (fieldName === "id")
    entry.idLine = lineNumber;
}
function isBacklogState(value) {
  return backlogStates.includes(value);
}
function isTaskId(value) {
  return typeof value === "string" && value.trim() === value && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}
function isTaskKind(value) {
  return value === "ship" || value === "scout" || value === "captain";
}
function isReviewHead(value) {
  return typeof value === "string" && value.trim() === value && /^[0-9a-f]{7,64}$/i.test(value);
}
function isTaskActions(value) {
  if (!Array.isArray(value) || value.length > 4)
    return false;
  const labels = new Set;
  for (const action of value) {
    if (typeof action !== "object" || action === null || Array.isArray(action))
      return false;
    if (typeof action.label !== "string" || typeof action.text !== "string")
      return false;
    const label = action.label.trim();
    if (label === "" || action.text.trim() === "" || labels.has(label))
      return false;
    labels.add(label);
  }
  return true;
}
function parseTaskActions(value) {
  if (value === "")
    return [];
  const segments = [];
  let segment = "";
  for (let index = 0;index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\") {
      const escaped = value[index + 1];
      if (escaped !== "\\" && escaped !== "|")
        return;
      segment += escaped;
      index += 1;
    } else if (character === "|") {
      segments.push(segment);
      segment = "";
    } else {
      segment += character;
    }
  }
  segments.push(segment);
  if (segments.length > 4)
    return;
  const actions = [];
  for (const entry of segments) {
    const separator = entry.indexOf("=>");
    if (separator === -1)
      return;
    actions.push({ label: entry.slice(0, separator).trim(), text: entry.slice(separator + 2).trim() });
  }
  return isTaskActions(actions) ? actions : undefined;
}
async function loadBacklog(filesystem, backlogPath) {
  return parseBacklog(await filesystem.readFile(backlogPath));
}

// service/pr-cleanup.ts
async function cleanupCoordinatorPullRequests(input) {
  const { filesystem, homeRoot, registration } = input;
  const backlogPath = `${registration.homeDirectory}/backlog.md`;
  const backlog = await loadBacklog(filesystem, backlogPath);
  if (backlog.errors.length > 0)
    throw new Error("PR cleanup needs a readable backlog without malformed entries");
  const archived = await loadHostArchivedSessionIds(filesystem, homeRoot, registration.slug);
  const candidates = new Set;
  for (const task of backlog.tasks) {
    const url = canonicalPullUrl(task.prUrl);
    if (url === undefined || candidates.has(url))
      continue;
    const references = backlog.tasks.filter((entry) => canonicalPullUrl(entry.prUrl) === url);
    if (references.every((entry) => resolvedTask(entry, archived)) && await reportsExist(references))
      candidates.add(url);
  }
  if (candidates.size === 0)
    return [];
  const sessionPath = `/api/openchamber/sessions/${encodeURIComponent(registration.coordinatorSessionId)}`;
  const observation = await callDesktopProxy({ ...input, method: "GET", path: `${sessionPath}/metadata?directory=${encodeURIComponent(registration.homeDirectory)}`, label: "PR cleanup metadata" });
  if (observation.kind !== "ok")
    throw new Error(observation.kind === "failed" ? observation.message : observation.reason);
  const links = readLinks(observation.text);
  const entries = [];
  for (const value of links) {
    if (!isPullLink(value))
      continue;
    const url = canonicalPullUrl(value.url);
    if (url === undefined || !candidates.has(url))
      continue;
    if (links.some((other) => isRecord(other) && other.id === value.id && (!isPullLink(other) || canonicalPullUrl(other.url) !== url)))
      continue;
    const response = JSON.parse(await input.exec("gh", ["pr", "view", url, "--json", "state,mergedAt,url"]));
    if (!isRecord(response) || canonicalPullUrl(response.url) !== url || !["OPEN", "CLOSED", "MERGED"].includes(response.state)) {
      throw new Error(`GitHub did not identify the requested PR: ${url}`);
    }
    if (response.state !== "MERGED")
      continue;
    if (typeof response.mergedAt !== "string" || !Number.isFinite(Date.parse(response.mergedAt)))
      throw new Error(`GitHub did not confirm a merge time: ${url}`);
    entries.push(value);
  }
  if (entries.length === 0)
    return [];
  const current = (await loadRegistry(filesystem, homeRoot))[registration.slug];
  if (current?.coordinatorSessionId !== registration.coordinatorSessionId || current?.homeDirectory !== registration.homeDirectory || current?.projectDirectory !== registration.projectDirectory) {
    throw new Error("the registered first mate changed during PR cleanup");
  }
  const latest = await loadBacklog(filesystem, backlogPath);
  if (latest.errors.length > 0 || JSON.stringify(latest.tasks) !== JSON.stringify(backlog.tasks))
    throw new Error("the backlog changed during PR cleanup");
  const references = backlog.tasks.filter((task) => entries.some((entry) => canonicalPullUrl(entry.url) === canonicalPullUrl(task.prUrl)));
  if (!await reportsExist(references))
    throw new Error("saved reports changed during PR cleanup");
  const outcome = await callDesktopProxy({
    ...input,
    method: "POST",
    path: `${sessionPath}/links`,
    label: "PR unlink",
    body: JSON.stringify({ directory: registration.homeDirectory, entries, linked: false })
  });
  if (outcome.kind !== "ok")
    throw new Error(outcome.kind === "failed" ? outcome.message : outcome.reason);
  const remaining = readLinks(outcome.text, true);
  if (remaining.some((entry) => isRecord(entry) && entries.some((removed) => entry.id === removed.id || canonicalPullUrl(entry.url) === canonicalPullUrl(removed.url)))) {
    throw new Error("the host did not confirm removal of the completed PR links");
  }
  return [...new Set(entries.map((entry) => entry.url))];
  async function reportsExist(tasks) {
    for (const task of tasks) {
      const reportPath = `${registration.homeDirectory}/reports/${task.id}.md`;
      if (!await filesystem.exists(reportPath) || (await filesystem.readFile(reportPath)).trim() === "")
        return false;
    }
    return true;
  }
}
function resolvedTask(task, archived) {
  return task.state === "Done" && task.kind !== "captain" && task.id !== undefined && task.sessionId !== undefined && archived.has(task.sessionId) && task.hold === undefined && task.blockedBy === undefined && (task.actions?.length ?? 0) === 0;
}
function canonicalPullUrl(value) {
  if (typeof value !== "string")
    return;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port !== "" || url.username !== "" || url.password !== "")
      return;
    const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)\/?$/i.exec(url.pathname);
    return match === null ? undefined : `https://github.com/${match[1].toLowerCase()}/${match[2].toLowerCase()}/pull/${match[3]}`;
  } catch {
    return;
  }
}
function readLinks(text, requireList = false) {
  const parsed = JSON.parse(text ?? "null");
  if (!isRecord(parsed) || !isRecord(parsed.metadata))
    throw new Error("the host did not return session metadata for PR cleanup");
  const metadata = parsed.metadata;
  if (metadata.openchamber === undefined && !requireList)
    return [];
  if (!isRecord(metadata.openchamber))
    throw new Error("the host returned malformed PR link metadata");
  const links = metadata.openchamber.linked_issues;
  if (links === undefined && !requireList)
    return [];
  if (!Array.isArray(links))
    throw new Error("the host returned a malformed PR link list");
  return links;
}
function isPullLink(value) {
  return isRecord(value) && value.kind === "pull" && typeof value.id === "string" && value.id !== "" && typeof value.title === "string" && value.title !== "" && typeof value.url === "string";
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// service/cleanup-pr-links.ts
var helpText = `Usage: cleanup-pr-links [--help]

Run from the registered FirstMate home. Remove only eligible merged PR links
from that project's current first mate. No session or URL override is accepted.
Saved evidence, worker links, sessions, worktrees, and branches stay intact.
The JSON result lists confirmed removals, not proof that all cleanup is done.
`;
async function runPullRequestCleanup(argumentsList, ports) {
  if (argumentsList.length === 1 && argumentsList[0] === "--help")
    return helpText;
  if (argumentsList.length !== 0)
    throw new Error("PR cleanup accepts no arguments except --help");
  const registrations = Object.values(await loadRegistry(ports.filesystem, ports.homeRoot));
  const matches = registrations.filter((entry) => path2.resolve(entry.homeDirectory) === path2.resolve(ports.cwd()));
  if (matches.length !== 1 || path2.resolve(matches[0].homeDirectory) !== resolveProjectHomeDirectory(ports.homeRoot, matches[0].slug)) {
    throw new Error("run PR cleanup from exactly one registered FirstMate home");
  }
  const registration = matches[0];
  const unlinked = await cleanupCoordinatorPullRequests({ ...ports, registration, support: await discoverSupport({ filesystem: ports.filesystem, settingsPath: ports.settingsPath }) });
  return `${JSON.stringify({ coordinatorSessionId: registration.coordinatorSessionId, unlinked, note: "Other links may remain unresolved or intentionally retained. No repository cleanup was performed." })}
`;
}
var unavailable = async () => {
  throw new Error("PR cleanup does not write filesystem records");
};
var filesystem = {
  exists: async (filePath) => {
    try {
      await stat(filePath);
      return true;
    } catch (error) {
      if (error.code === "ENOENT")
        return false;
      throw error;
    }
  },
  readFile: (filePath) => readFile(filePath, "utf8"),
  writeFile: unavailable,
  appendFile: unavailable,
  createDirectory: unavailable,
  rename: unavailable,
  listDirectories: unavailable,
  listExecutableFiles: unavailable,
  setExecutable: unavailable
};
var exec = (command, argumentsList) => new Promise((resolve, reject) => {
  if (command !== "gh") {
    reject(new Error("PR cleanup can run only GitHub reads"));
    return;
  }
  const child = spawn(command, [...argumentsList], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.resume();
  child.on("error", () => reject(new Error("GitHub CLI could not be started")));
  child.on("close", (code) => code === 0 ? resolve(Buffer.concat(output).toString("utf8")) : reject(new Error(`GitHub read failed with exit code ${code}`)));
});
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path2.resolve(process.argv[1])).href) {
  const homeRoot = process.env.FIRSTMATE_HOME ?? path2.join(homedir(), ".config", "firstmate");
  runPullRequestCleanup(process.argv.slice(2), {
    filesystem,
    homeRoot,
    cwd: () => process.cwd(),
    exec,
    fetcher: (url, init) => fetch(url, init),
    settingsPath: process.env.FIRSTMATE_OPENCHAMBER_SETTINGS ?? path2.join(homedir(), ".config", "openchamber", "settings.json")
  }).then((output) => process.stdout.write(output)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "PR cleanup failed"}
`);
    process.exitCode = 1;
  });
}
export {
  runPullRequestCleanup
};
