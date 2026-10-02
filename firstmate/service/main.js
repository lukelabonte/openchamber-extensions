// service/main.ts
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, readFile, readdir, rename, stat, writeFile, appendFile, constants as fsConstants } from "node:fs/promises";
import { homedir } from "node:os";
import path2 from "node:path";

// service/control-client.ts
class MissingCliError extends Error {
  constructor() {
    super("the openchamber CLI is required. Install it with: npm i -g @openchamber/web");
    this.name = "MissingCliError";
  }
}

class SessionBusyError extends Error {
  constructor() {
    super("the session is busy and cannot accept a message right now");
    this.name = "SessionBusyError";
  }
}
async function createSession(exec, input) {
  const output = await runControlCommand(exec, ["session", "create", "--dir", input.directory, "--title", input.title, "--json"]);
  const parsed = parseJsonOutput(output);
  const sessionId = extractSessionId(parsed);
  if (sessionId === undefined) {
    throw new Error("openchamber session create output did not include a session id");
  }
  return sessionId;
}
async function sessionStatus(exec, input) {
  const output = await runControlCommand(exec, ["session", "status", "--session", input.sessionId, "--dir", input.directory, "--json"]);
  const parsed = parseJsonOutput(output);
  return { activity: extractActivity(parsed), outcome: extractOutcome(parsed) };
}
async function sessionMessagesLastAssistant(exec, input) {
  const output = await runControlCommand(exec, ["session", "messages", "--session", input.sessionId, "--dir", input.directory, "--last-assistant", "--json"]);
  const parsed = parseJsonOutput(output);
  return extractAssistantText(parsed);
}
async function sessionSend(exec, input) {
  try {
    await runControlCommand(exec, ["session", "send", "--session", input.sessionId, "--dir", input.directory, "--prompt", input.prompt, "--json"]);
  } catch (error) {
    if (error instanceof Error && /busy/i.test(error.message)) {
      throw new SessionBusyError;
    }
    throw error;
  }
}
async function runControlCommand(exec, args) {
  try {
    return await exec("openchamber", args);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new MissingCliError;
    }
    throw error;
  }
}
function parseJsonOutput(output) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error("openchamber command did not return valid JSON");
  }
}
function extractSessionId(parsed) {
  if (!isRecord(parsed))
    return;
  for (const key of ["sessionID", "sessionId", "id"]) {
    const value = parsed[key];
    if (typeof value === "string" && value !== "")
      return value;
  }
  return;
}
var knownActivities = ["unknown", "idle", "running", "retrying", "waiting-permission", "waiting-question"];
function extractActivity(parsed) {
  if (!isRecord(parsed))
    return "unknown";
  for (const key of ["type", "activity", "status"]) {
    const value = parsed[key];
    if (typeof value === "string" && knownActivities.includes(value)) {
      return value;
    }
  }
  return "unknown";
}
function extractOutcome(parsed) {
  if (!isRecord(parsed))
    return null;
  const value = parsed.outcome;
  if (value === "completed" || value === "failed")
    return value;
  return null;
}
function extractAssistantText(parsed) {
  if (typeof parsed === "string")
    return parsed === "" ? undefined : parsed;
  if (!isRecord(parsed))
    return;
  for (const key of ["text", "content", "message"]) {
    const value = parsed[key];
    if (typeof value === "string" && value !== "")
      return value;
  }
  return;
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

// service/actions.ts
async function steerWorker(input) {
  await sessionSend(input.exec, {
    sessionId: input.worker.sessionId,
    directory: input.workerDirectory,
    prompt: input.text
  });
  try {
    await sessionSend(input.exec, {
      sessionId: input.coordinator.sessionId,
      directory: input.coordinator.directory,
      prompt: `The captain steered worker "${input.worker.title}": ${input.text}`
    });
    return { coordinatorNotified: true };
  } catch (error) {
    return { coordinatorNotified: false, coordinatorError: error instanceof Error ? error.message : String(error) };
  }
}
async function sendCoordinatorMessage(input) {
  await sessionSend(input.exec, {
    sessionId: input.coordinator.sessionId,
    directory: input.coordinator.directory,
    prompt: input.text
  });
}
async function requestRelaunch(input) {
  await sessionSend(input.exec, {
    sessionId: input.coordinator.sessionId,
    directory: input.coordinator.directory,
    prompt: `The captain requested a relaunch of worker "${input.worker.title}" (session ${input.worker.sessionId}): ` + `launch a fresh worker in the existing worktree ${input.worktreeDirectory}; ` + `the conversation does not carry over. Update the backlog to supersede the old entry. ` + `The captain's note: ${input.note}`
  });
}

// service/archive.ts
function archivePath(homeRoot, slug) {
  return `${homeRoot}/projects/${slug}/reports/archive.jsonl`;
}
async function loadArchivedSessionIds(filesystem, homeRoot, slug) {
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
      if (isArchiveEntry(parsed))
        ids.add(parsed.sessionId);
    } catch {}
  }
  return ids;
}
async function archiveSession(filesystem, homeRoot, slug, entry) {
  await filesystem.createDirectory(`${homeRoot}/projects/${slug}/reports`);
  await filesystem.appendFile(archivePath(homeRoot, slug), `${JSON.stringify(entry)}
`);
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
  session: "sessionId",
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
  if (value === "") {
    entry.problem = { line: lineNumber, message: `the entry "${entry.title}" has an empty "${key}" field` };
    return;
  }
  if (timestampFields.includes(fieldName) && Number.isNaN(Date.parse(value))) {
    entry.problem = { line: lineNumber, message: `the entry "${entry.title}" has a "${key}" that is not a timestamp` };
    return;
  }
  entry.fields[fieldName] = value;
}
function isBacklogState(value) {
  return backlogStates.includes(value);
}
async function loadBacklog(filesystem, backlogPath) {
  return parseBacklog(await filesystem.readFile(backlogPath));
}

// service/compose.ts
async function composeInstructions(input) {
  const { filesystem, homeRoot, slug } = input;
  const relativePaths = [
    "shared/charter.md",
    `projects/${slug}/charter.md`,
    "shared/captain.md",
    `projects/${slug}/captain.md`
  ];
  const layers = await Promise.all(relativePaths.map(async (relativePath) => {
    const filePath = `${homeRoot}/${relativePath}`;
    if (!await filesystem.exists(filePath)) {
      return { relativePath, contents: undefined };
    }
    return { relativePath, contents: (await filesystem.readFile(filePath)).trim() };
  }));
  const headerLines = layers.map((layer, index) => `${index + 1}. ${layer.relativePath} — ${layer.contents === undefined ? "skipped (missing)" : "included"}`);
  const header = `<!-- FirstMate composed instructions. Do not edit by hand — edit the layer files and recompose.
Layers, lowest to highest precedence (a later layer outranks earlier ones; a project file adds to or overrides the shared file of its kind):
${headerLines.join(`
`)}
-->`;
  const body = layers.filter((layer) => layer.contents !== undefined).map((layer) => `<!-- layer: ${layer.relativePath} -->

${layer.contents}`).join(`

`);
  const composed = `${header}

${body}
`;
  await filesystem.writeFile(`${homeRoot}/projects/${slug}/AGENTS.md`, composed);
  return composed;
}

// service/clock.ts
function createNodeClock() {
  return {
    nowMs: () => Date.now(),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    startInterval: (callback, intervalMs) => {
      const timer = setInterval(callback, intervalMs);
      return { cancel: () => clearInterval(timer) };
    }
  };
}

// service/forwarder.ts
var busyRetryDelaysMs = [30000, 120000, 300000];
var steadyRetryDelayMs = 300000;
async function deliverNotification(input) {
  const { exec, clock, notification } = input;
  for (let attempt = 0;; attempt += 1) {
    try {
      await sessionSend(exec, {
        sessionId: notification.coordinatorSessionId,
        directory: notification.homeDirectory,
        prompt: notification.message
      });
      return;
    } catch (error) {
      if (!(error instanceof SessionBusyError))
        throw error;
      await clock.delay(attempt < busyRetryDelaysMs.length ? busyRetryDelaysMs[attempt] : steadyRetryDelayMs);
    }
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
async function interruptWorker(input) {
  if (input.support.kind === "unsupported") {
    return { kind: "unsupported", reason: input.support.reason };
  }
  const url = `http://127.0.0.1:${input.support.port}/api/session/${input.sessionId}/interrupt?directory=${encodeURIComponent(input.directory)}`;
  const headers = {};
  if (input.support.token !== undefined)
    headers.authorization = `Bearer ${input.support.token}`;
  try {
    const result = await input.fetcher(url, { method: "POST", headers });
    if (result.status >= 200 && result.status < 300)
      return { kind: "ok" };
    if (result.status === 401 || result.status === 403) {
      return {
        kind: "unsupported",
        reason: `the abort call was rejected with status ${result.status}: this host requires credentials that were not offered`
      };
    }
    return { kind: "failed", message: `the abort call answered with status ${result.status}` };
  } catch (error) {
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

// service/slug.ts
import path from "node:path";
var HASH_HEX_LENGTH = 8;
function normalizeProjectDirectory(projectDirectory) {
  return path.resolve(projectDirectory.trim());
}
function deriveSlug(projectDirectory, existingProjectDirectories = []) {
  const trimmedDirectory = projectDirectory.trim();
  const baseSlug = slugifyBase(path.basename(trimmedDirectory));
  const candidateSlug = baseSlug === "" ? `project-${pathHash(trimmedDirectory)}` : baseSlug;
  const isTaken = existingProjectDirectories.some((existingDirectory) => normalizeDirectory(existingDirectory) !== normalizeDirectory(trimmedDirectory) && slugifyBase(path.basename(existingDirectory)) === baseSlug);
  return isTaken ? `${candidateSlug}-${pathHash(trimmedDirectory)}` : candidateSlug;
}
function slugifyBase(baseName) {
  return baseName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function normalizeDirectory(directoryPath) {
  return directoryPath.replace(/\/+$/, "");
}
function pathHash(directoryPath) {
  let hash = 2166136261;
  for (let index = 0;index < directoryPath.length; index++) {
    hash ^= directoryPath.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(HASH_HEX_LENGTH, "0");
}

// service/provision.ts
var sharedDirectories = ["watches"];
var sharedFiles = [
  { templateName: "charter.md", fileName: "charter.md" },
  { templateName: "captain.md", fileName: "captain.md" },
  { templateName: "watches-README.md", fileName: "watches/README.md" },
  { templateName: "pr-watch", fileName: "watches/pr-watch", executable: true }
];
var projectDirectories = ["briefs", "reports", "watches"];
var projectFiles = [
  { templateName: "project-charter.md", fileName: "charter.md" },
  { templateName: "captain.md", fileName: "captain.md" },
  { templateName: "backlog.md", fileName: "backlog.md" },
  { templateName: "projects.md", fileName: "projects.md" }
];
async function provisionProject(input) {
  const { filesystem, templateReader, homeRoot, projectDirectory } = input;
  const normalizedDirectory = normalizeProjectDirectory(projectDirectory);
  const projectsRoot = `${homeRoot}/projects`;
  const homeNames = await filesystem.listDirectories(projectsRoot);
  const matchedHome = await findProjectHomeSlug({ filesystem, projectsRoot, homeNames, projectDirectory: normalizedDirectory });
  const existingProjectDirectories = homeNames.map((name) => `${projectsRoot}/${name}`);
  const slug = matchedHome ?? deriveSlug(normalizedDirectory, existingProjectDirectories);
  const projectHomeDirectory = `${projectsRoot}/${slug}`;
  await filesystem.createDirectory(`${homeRoot}/shared`);
  await filesystem.createDirectory(projectHomeDirectory);
  await createFiles({
    filesystem,
    templateReader,
    parentDirectory: `${homeRoot}/shared`,
    directories: sharedDirectories,
    files: sharedFiles
  });
  await createFiles({
    filesystem,
    templateReader,
    parentDirectory: projectHomeDirectory,
    directories: projectDirectories,
    files: projectFiles
  });
  if (matchedHome === undefined) {
    await writeSettingsAssociation({
      filesystem,
      templateReader,
      settingsPath: `${projectHomeDirectory}/settings.json`,
      projectDirectory: normalizedDirectory
    });
  }
  return { slug, projectHomeDirectory };
}
async function findProjectHomeSlug(input) {
  const { filesystem, projectsRoot, homeNames, projectDirectory } = input;
  for (const homeName of homeNames) {
    const settingsPath = `${projectsRoot}/${homeName}/settings.json`;
    if (!await filesystem.exists(settingsPath))
      continue;
    let settings;
    try {
      settings = JSON.parse(await filesystem.readFile(settingsPath));
    } catch {
      continue;
    }
    if (isRecord2(settings) && settings.projectDirectory === projectDirectory) {
      return homeName;
    }
  }
  return;
}
async function writeSettingsAssociation(input) {
  const settings = JSON.parse(await input.templateReader("settings.json"));
  settings.projectDirectory = input.projectDirectory;
  await input.filesystem.writeFile(input.settingsPath, `${JSON.stringify(settings, null, 2)}
`);
}
function isRecord2(value) {
  return typeof value === "object" && value !== null;
}
async function createFiles(input) {
  const { filesystem, templateReader, parentDirectory, directories, files } = input;
  for (const directory of directories) {
    await filesystem.createDirectory(`${parentDirectory}/${directory}`);
  }
  for (const file of files) {
    const filePath = `${parentDirectory}/${file.fileName}`;
    if (await filesystem.exists(filePath))
      continue;
    await filesystem.writeFile(filePath, await templateReader(file.templateName));
    if (file.executable === true)
      await filesystem.setExecutable(filePath);
  }
}

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
async function saveRegistry(filesystem, homeRoot, registrations) {
  const filePath = registryPath(homeRoot);
  const tempPath = `${filePath}.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  await filesystem.writeFile(tempPath, `${JSON.stringify(registrations, null, 2)}
`);
  await filesystem.rename(tempPath, filePath);
}
function findRegistration(registrations, projectDirectory) {
  const normalizedDirectory = normalizeProjectDirectory(projectDirectory);
  return Object.values(registrations).find((registration) => registration.projectDirectory === normalizedDirectory);
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
var launchesInFlight = new Map;
async function launchFirstMate(input) {
  const key = normalizeProjectDirectory(input.projectDirectory);
  const previous = launchesInFlight.get(key) ?? Promise.resolve();
  const launch = previous.catch(() => {
    return;
  }).then(() => launchOnce(input));
  launchesInFlight.set(key, launch);
  try {
    return await launch;
  } finally {
    if (launchesInFlight.get(key) === launch) {
      launchesInFlight.delete(key);
    }
  }
}
async function launchOnce(input) {
  const { filesystem, exec, templateReader, homeRoot } = input;
  const normalizedDirectory = normalizeProjectDirectory(input.projectDirectory);
  const registrations = await loadRegistry(filesystem, homeRoot);
  const existing = findRegistration(registrations, normalizedDirectory);
  if (existing !== undefined) {
    return { registration: existing, adopted: true };
  }
  const { slug, projectHomeDirectory } = await provisionProject({
    filesystem,
    templateReader,
    homeRoot,
    projectDirectory: normalizedDirectory
  });
  await composeInstructions({ filesystem, homeRoot, slug });
  const settingsPath = `${projectHomeDirectory}/settings.json`;
  const priorSessionId = await readCoordinatorSessionId(filesystem, settingsPath);
  if (priorSessionId !== undefined) {
    const registration = {
      slug,
      projectDirectory: normalizedDirectory,
      homeDirectory: projectHomeDirectory,
      coordinatorSessionId: priorSessionId,
      createdAt: new Date().toISOString()
    };
    await saveRegistry(filesystem, homeRoot, { ...registrations, [slug]: registration });
    return { registration, adopted: true };
  }
  let coordinatorSessionId;
  try {
    coordinatorSessionId = await createSession(exec, {
      directory: projectHomeDirectory,
      title: `FirstMate — ${slug}`
    });
  } catch (error) {
    if (error instanceof MissingCliError)
      throw error;
    throw new Error(`could not create the coordinator session: ${error instanceof Error ? error.message : String(error)}`);
  }
  await recordCoordinatorSessionId(filesystem, settingsPath, coordinatorSessionId);
  const registration = {
    slug,
    projectDirectory: normalizedDirectory,
    homeDirectory: projectHomeDirectory,
    coordinatorSessionId,
    createdAt: new Date().toISOString()
  };
  await saveRegistry(filesystem, homeRoot, { ...registrations, [slug]: registration });
  return { registration, adopted: false };
}
async function readCoordinatorSessionId(filesystem, settingsPath) {
  let parsed;
  try {
    parsed = JSON.parse(await filesystem.readFile(settingsPath));
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return;
  const value = parsed.coordinatorSessionId;
  return typeof value === "string" && value !== "" ? value : undefined;
}
async function recordCoordinatorSessionId(filesystem, settingsPath, coordinatorSessionId) {
  let settings = {};
  try {
    const parsed = JSON.parse(await filesystem.readFile(settingsPath));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      settings = parsed;
    }
  } catch {}
  settings.coordinatorSessionId = coordinatorSessionId;
  await filesystem.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}
`);
}

// service/board.ts
var lastWordMaxLength = 280;
function mapBoardState(input) {
  const { backlogState, live } = input;
  if (backlogState !== "Queued" && backlogState !== "Working") {
    return { state: backlogState };
  }
  if (live === undefined)
    return { state: backlogState };
  if (live.outcome === "failed")
    return { state: "Failed" };
  if (live.activity === "waiting-question")
    return { state: "Blocked", blockedReason: "question" };
  if (live.activity === "waiting-permission")
    return { state: "Blocked", blockedReason: "permission" };
  if (live.activity === "running" || live.activity === "retrying")
    return { state: "Working" };
  if (backlogState === "Working" && live.activity === "idle") {
    return { state: live.outcome === "completed" ? "Working" : "Idle" };
  }
  return { state: backlogState };
}
function buildBoardWorker(task, observation) {
  const refined = task.sessionId === undefined ? { state: task.state, blockedReason: undefined } : mapBoardState({ backlogState: task.state, live: observation?.status });
  const worker = {
    title: task.title,
    state: refined.state,
    ...refined.blockedReason !== undefined ? { blockedReason: refined.blockedReason } : {},
    ...task.prUrl !== undefined ? { prUrl: task.prUrl } : {},
    ...task.sessionId !== undefined ? { sessionId: task.sessionId } : {},
    ...task.worktreeDirectory !== undefined ? { worktree: task.worktreeDirectory } : {},
    ...task.branch !== undefined ? { branch: task.branch } : {}
  };
  const lastWord = observation?.lastWord;
  if (lastWord !== undefined)
    worker.lastWord = truncateLastWord(lastWord);
  if (observation?.error !== undefined)
    worker.lastPollError = observation.error;
  return worker;
}
function truncateLastWord(text) {
  return text.length > lastWordMaxLength ? `${text.slice(0, lastWordMaxLength)}…` : text;
}

// service/poller.ts
function createSupervisionPoller(input) {
  const { filesystem, exec, homeRoot } = input;
  const observations = new Map;
  const pollErrors = new Map;
  const deliveryErrors = new Map;
  const steeredBaselines = new Map;
  const observationKey = (slug, sessionId) => `${slug}
${sessionId}`;
  async function poll() {
    const notifications = [];
    let registrations;
    try {
      registrations = await loadRegistry(filesystem, homeRoot);
    } catch {
      return { notifications };
    }
    for (const registration of Object.values(registrations)) {
      const events = await pollProject(registration);
      if (events.length > 0) {
        notifications.push(composeNotification(registration, events));
      }
    }
    return { notifications };
  }
  async function pollProject(registration) {
    const events = [];
    let backlog;
    try {
      backlog = await loadBacklog(filesystem, `${homeRoot}/projects/${registration.slug}/backlog.md`);
    } catch {
      return events;
    }
    let archivedSessionIds;
    try {
      archivedSessionIds = await loadArchivedSessionIds(filesystem, homeRoot, registration.slug);
    } catch {
      return events;
    }
    for (const task of backlog.tasks) {
      if (task.sessionId === undefined)
        continue;
      if (archivedSessionIds.has(task.sessionId))
        continue;
      const key = observationKey(registration.slug, task.sessionId);
      const previous = observations.get(key);
      try {
        const directory = registration.projectDirectory;
        const status = await sessionStatus(exec, { sessionId: task.sessionId, directory });
        const lastWord = await sessionMessagesLastAssistant(exec, { sessionId: task.sessionId, directory });
        const current = { status, ...lastWord !== undefined ? { lastWord } : {} };
        observations.set(key, current);
        pollErrors.delete(key);
        events.push(...detectEvents(task, previous, current));
        if (steeredBaselines.has(key) && current.lastWord !== undefined && current.lastWord !== steeredBaselines.get(key)) {
          steeredBaselines.delete(key);
          events.push({
            taskTitle: task.title,
            sessionId: task.sessionId,
            kind: "steered-answer",
            answer: current.lastWord
          });
        }
      } catch (error) {
        pollErrors.set(key, error instanceof Error ? error.message : String(error));
      }
    }
    return events;
  }
  function detectEvents(task, previous, current) {
    const events = [];
    const emit = (kind) => ({ taskTitle: task.title, sessionId: task.sessionId, kind });
    const activity = current.status.activity;
    const outcome = current.status.outcome;
    if (outcome === "failed" && previous?.status.outcome !== "failed")
      events.push(emit("failed"));
    if (activity === "waiting-question" && previous?.status.activity !== "waiting-question")
      events.push(emit("waiting-question"));
    if (activity === "waiting-permission" && previous?.status.activity !== "waiting-permission")
      events.push(emit("waiting-permission"));
    if (outcome === "completed" && previous?.status.outcome !== "completed")
      events.push(emit("finished"));
    return events;
  }
  function getBoardWorkers(slug, tasks) {
    return tasks.map((task) => {
      const observation = task.sessionId === undefined ? undefined : observations.get(observationKey(slug, task.sessionId));
      const error = task.sessionId === undefined ? undefined : pollErrors.get(observationKey(slug, task.sessionId));
      const merged = observation === undefined && error === undefined ? undefined : { ...observation ?? { status: { activity: "unknown", outcome: null } }, ...error !== undefined ? { error } : {} };
      return buildBoardWorker(task, merged);
    });
  }
  function getDeliveryError(slug) {
    return deliveryErrors.get(slug);
  }
  function recordDeliveryError(slug, message) {
    deliveryErrors.set(slug, message);
  }
  function clearDeliveryError(slug) {
    deliveryErrors.delete(slug);
  }
  function markSteered(slug, sessionId) {
    const key = observationKey(slug, sessionId);
    steeredBaselines.set(key, observations.get(key)?.lastWord);
  }
  return { poll, getBoardWorkers, getDeliveryError, recordDeliveryError, clearDeliveryError, markSteered };
}
function composeNotification(registration, events) {
  const lines = events.map((event) => `- "${event.taskTitle}" (${event.sessionId}): ${describeEvent(event)}`);
  return {
    slug: registration.slug,
    coordinatorSessionId: registration.coordinatorSessionId,
    homeDirectory: registration.homeDirectory,
    message: [`FirstMate (${registration.slug}) worker update:`, ...lines].join(`
`)
  };
}
function describeEvent(event) {
  switch (event.kind) {
    case "finished":
      return "finished its turn (outcome: completed). Review the work and mark the task Done when satisfied — completed never means Done.";
    case "failed":
      return "failed (outcome: failed).";
    case "waiting-question":
      return "is waiting on a question. Open the session to read and answer it.";
    case "waiting-permission":
      return "is waiting on a permission. Open the session to approve or deny it.";
    case "steered-answer":
      return `answered the captain's steer: ${event.answer ?? ""}`;
  }
}

// service/landing-record.ts
function landingRecordPath(homeRoot, slug) {
  return `${homeRoot}/projects/${slug}/reports/landings.md`;
}
var fieldKeys2 = ["commit", "ci", "mode", "authorization", "landed"];
var authorizations = ["captain's word", "+yolo"];
function parseLandingRecords(markdown) {
  const records = [];
  const errors = [];
  let entry;
  const closeEntry = () => {
    if (entry === undefined)
      return;
    const draft = entry;
    entry = undefined;
    if (draft.problem !== undefined) {
      errors.push(draft.problem);
      return;
    }
    const missing = fieldKeys2.find((key) => draft.fields[key] === undefined);
    if (missing !== undefined) {
      errors.push({ line: draft.titleLine, message: `the entry "${draft.title}" has no ${missing} line` });
      return;
    }
    const fields = draft.fields;
    records.push({
      task: draft.title,
      commit: fields.commit,
      ci: fields.ci,
      mode: fields.mode,
      authorization: fields.authorization,
      landedAt: fields.landed
    });
  };
  markdown.split(`
`).forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
    if (bullet !== null) {
      closeEntry();
      entry = { titleLine: lineNumber, title: bullet[1].trim(), fields: {} };
      return;
    }
    if (trimmed === "")
      return;
    if (trimmed.startsWith("#")) {
      closeEntry();
      return;
    }
    const field = /^([A-Za-z][A-Za-z-]*):\s*(.*)$/.exec(trimmed);
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      closeEntry();
      return;
    }
    if (entry === undefined)
      return;
    applyField2(entry, field, lineNumber);
  });
  closeEntry();
  return { records, errors };
}
function applyField2(entry, field, lineNumber) {
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
  if (!fieldKeys2.includes(key)) {
    entry.problem = { line: lineNumber, message: `the entry "${entry.title}" has an unknown field "${key}"` };
    return;
  }
  const landingKey = key;
  if (entry.fields[landingKey] !== undefined) {
    entry.problem = { line: lineNumber, message: `the entry "${entry.title}" repeats the "${key}" field` };
    return;
  }
  if (value === "") {
    entry.problem = { line: lineNumber, message: `the entry "${entry.title}" has an empty "${key}" field` };
    return;
  }
  if (landingKey === "authorization" && !authorizations.includes(value)) {
    entry.problem = {
      line: lineNumber,
      message: `the entry "${entry.title}" has an unknown authorization "${value}"`
    };
    return;
  }
  if (landingKey === "landed" && Number.isNaN(Date.parse(value))) {
    entry.problem = { line: lineNumber, message: `the entry "${entry.title}" has a "landed" that is not a timestamp` };
    return;
  }
  entry.fields[landingKey] = value;
}
async function loadLandingRecords(filesystem, homeRoot, slug) {
  const filePath = landingRecordPath(homeRoot, slug);
  if (!await filesystem.exists(filePath))
    return { records: [], errors: [] };
  return parseLandingRecords(await filesystem.readFile(filePath));
}

// service/shipping-mode.ts
var shippingModes = ["direct-PR", "reviewed-PR", "local-only"];
function isShippingMode(value) {
  return shippingModes.includes(value);
}
function parseShippingMode(markdown) {
  for (const line of markdown.split(`
`)) {
    const field = /^mode:\s*(.*)$/.exec(line.trim());
    if (field === null)
      continue;
    return parseModeValue(field[1].trim());
  }
  return { mode: null, yolo: false };
}
function parseModeValue(value) {
  const yolo = value.endsWith("+yolo");
  const base = (yolo ? value.slice(0, -"+yolo".length) : value).trim();
  if (!isShippingMode(base))
    return { mode: null, yolo: false };
  return { mode: base, yolo };
}

// service/suggestions.ts
function suggestionsPath(homeRoot, slug) {
  return `${homeRoot}/projects/${slug}/suggestions.md`;
}
var suggestionLine = /^-\s+(.+?)\s*::\s*(.+)$/;
function parseSuggestions(markdown) {
  const suggestions = [];
  for (const line of markdown.split(`
`)) {
    const match = suggestionLine.exec(line.trim());
    if (match !== null)
      suggestions.push({ label: match[1], text: match[2] });
  }
  return suggestions;
}
async function loadSuggestions(filesystem, filePath) {
  if (!await filesystem.exists(filePath))
    return [];
  return parseSuggestions(await filesystem.readFile(filePath));
}
async function removeSuggestion(filesystem, filePath, label) {
  if (!await filesystem.exists(filePath))
    return;
  const markdown = await filesystem.readFile(filePath);
  const kept = markdown.split(`
`).filter((line) => {
    const match = suggestionLine.exec(line.trim());
    return match === null || match[1] !== label;
  });
  await filesystem.writeFile(filePath, kept.join(`
`));
}

// service/watch-schedule.ts
class ScheduleParseError extends Error {
  constructor(expression, reason) {
    super(`invalid watch schedule "${expression}": ${reason}`);
    this.name = "ScheduleParseError";
  }
}
function parseCronExpression(expression) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new ScheduleParseError(expression, "expected 5 fields (minute hour day-of-month month day-of-week)");
  }
  const minutes = parseField(fields[0], 0, 59, expression);
  const hours = parseField(fields[1], 0, 23, expression);
  const daysOfMonth = parseField(fields[2], 1, 31, expression);
  const months = parseField(fields[3], 1, 12, expression);
  const daysOfWeek = parseField(fields[4], 0, 7, expression);
  if (daysOfWeek.has(7)) {
    daysOfWeek.delete(7);
    daysOfWeek.add(0);
  }
  if (fields[2] !== "*") {
    const shortestDayOfMonth = Math.min(...daysOfMonth);
    const longestRestrictedMonth = Math.max(...[...months].map((month) => daysInMonth[month - 1]));
    if (shortestDayOfMonth > longestRestrictedMonth) {
      throw new ScheduleParseError(expression, `no restricted month has a day ${shortestDayOfMonth}`);
    }
  }
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    anyDayOfMonth: fields[2] === "*",
    anyDayOfWeek: fields[4] === "*"
  };
}
var daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function parseField(field, min, max, expression) {
  const values = new Set;
  for (const part of field.split(",")) {
    const pieces = part.split("/");
    if (pieces.length > 2)
      throw new ScheduleParseError(expression, `"${part}" has too many steps`);
    const [base, stepPart] = pieces;
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      throw new ScheduleParseError(expression, `"${part}" has an invalid step`);
    }
    let low;
    let high;
    if (base === "*") {
      low = min;
      high = max;
    } else if (base.includes("-")) {
      const [from, to] = base.split("-");
      if (from === "" || to === "") {
        throw new ScheduleParseError(expression, `"${part}" has an empty range end`);
      }
      low = Number(from);
      high = Number(to);
    } else {
      low = Number(base);
      high = stepPart === undefined ? low : max;
    }
    if (!Number.isInteger(low) || !Number.isInteger(high)) {
      throw new ScheduleParseError(expression, `"${part}" is not a number, a range, or *`);
    }
    if (low < min || high > max || low > high) {
      throw new ScheduleParseError(expression, `"${part}" is out of range ${min}-${max}`);
    }
    for (let value = low;value <= high; value += step)
      values.add(value);
  }
  return values;
}
var searchBoundMs = 4 * 366 * 24 * 60 * 60000;
function computeNextRun(schedule, from) {
  const candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const deadlineMs = from.getTime() + searchBoundMs;
  while (candidate.getTime() <= deadlineMs) {
    if (!schedule.months.has(candidate.getMonth() + 1)) {
      candidate.setMonth(candidate.getMonth() + 1, 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(schedule, candidate)) {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }
    if (!schedule.hours.has(candidate.getHours())) {
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!schedule.minutes.has(candidate.getMinutes())) {
      candidate.setMinutes(candidate.getMinutes() + 1);
      continue;
    }
    return candidate;
  }
  return null;
}
function dayMatches(schedule, date) {
  if (schedule.anyDayOfMonth && schedule.anyDayOfWeek)
    return true;
  const domMatch = schedule.daysOfMonth.has(date.getDate());
  const dowMatch = schedule.daysOfWeek.has(date.getDay());
  if (schedule.anyDayOfMonth)
    return dowMatch;
  if (schedule.anyDayOfWeek)
    return domMatch;
  return domMatch || dowMatch;
}
function extractScheduleComment(scriptText) {
  for (const line of scriptText.split(`
`, 20)) {
    const match = /^#\s*schedule:\s*(.+?)\s*$/.exec(line);
    if (match !== null)
      return match[1];
  }
  return;
}

// service/watches.ts
class WatchSettingsError extends Error {
  constructor(settingsPath, cause) {
    super(`FirstMate settings file ${settingsPath} is unreadable (${cause}). Fix or delete it, then toggle the watch again.`);
    this.name = "WatchSettingsError";
  }
}
var lastOutputMaxLength = 2000;
var watchTimeoutMs = 60000;
function createWatchRunner(input) {
  const { filesystem, exec, clock, homeRoot } = input;
  const timeoutMs = input.timeoutMs ?? watchTimeoutMs;
  const runStates = new Map;
  const stateKey = (slug, source, name) => `${slug}
${source}
${name}`;
  async function discoverWatches(slug) {
    const directories = [
      { source: "shared", directory: `${homeRoot}/shared/watches` },
      { source: "project", directory: `${homeRoot}/projects/${slug}/watches` }
    ];
    const discovered = [];
    for (const { source, directory } of directories) {
      for (const name of await filesystem.listExecutableFiles(directory)) {
        const scriptPath = `${directory}/${name}`;
        let scriptText;
        try {
          scriptText = await filesystem.readFile(scriptPath);
        } catch {
          continue;
        }
        const expression = extractScheduleComment(scriptText);
        if (expression === undefined)
          continue;
        let error;
        try {
          parseCronExpression(expression);
        } catch (parseError) {
          error = parseError instanceof Error ? parseError.message : String(parseError);
        }
        discovered.push({
          name,
          source,
          schedule: expression,
          ...error !== undefined ? { error } : {},
          scriptPath
        });
      }
    }
    return discovered;
  }
  async function loadEnabledOverrides(slug) {
    const settingsPath = `${homeRoot}/projects/${slug}/settings.json`;
    if (!await filesystem.exists(settingsPath))
      return {};
    let settings;
    try {
      settings = JSON.parse(await filesystem.readFile(settingsPath));
    } catch {
      return {};
    }
    if (!isPlainObject2(settings))
      return {};
    const watches = settings.watches;
    if (!isPlainObject2(watches))
      return {};
    const overrides = {};
    for (const source of ["shared", "project"]) {
      if (isPlainObject2(watches[source]))
        overrides[source] = watches[source];
    }
    return overrides;
  }
  async function tick() {
    const notifications = [];
    let registrations;
    try {
      registrations = await loadRegistry(filesystem, homeRoot);
    } catch {
      return { notifications };
    }
    const nowMs = clock.nowMs();
    const now = new Date(nowMs);
    for (const registration of Object.values(registrations)) {
      const { slug, homeDirectory, coordinatorSessionId } = registration;
      const watches = await discoverWatches(slug);
      if (watches.length === 0)
        continue;
      const enabledOverrides = await loadEnabledOverrides(slug);
      for (const watch of watches) {
        if (watch.error !== undefined)
          continue;
        if (!isEnabled(enabledOverrides, watch.source, watch.name))
          continue;
        const key = stateKey(slug, watch.source, watch.name);
        let runState = runStates.get(key);
        if (runState === undefined) {
          const next = computeNextRun(parseCronExpression(watch.schedule), now);
          runState = { nextRunAtMs: next === null ? Number.POSITIVE_INFINITY : next.getTime() };
          runStates.set(key, runState);
        }
        if (nowMs < runState.nextRunAtMs)
          continue;
        await runWatch(registration, watch, runState, notifications);
        const following = computeNextRun(parseCronExpression(watch.schedule), new Date(clock.nowMs()));
        runState.nextRunAtMs = following === null ? Number.POSITIVE_INFINITY : following.getTime();
      }
    }
    return { notifications };
  }
  async function runWatch(registration, watch, runState, notifications) {
    const { slug, homeDirectory, coordinatorSessionId } = registration;
    const stateDirectory = `${homeDirectory}/watch-state/${watch.name}`;
    runState.lastRunAt = new Date(clock.nowMs()).toISOString();
    let execution;
    let execError;
    try {
      await filesystem.createDirectory(stateDirectory);
      execution = await exec({
        scriptPath: watch.scriptPath,
        cwd: homeDirectory,
        env: {
          FIRSTMATE_HOME: homeDirectory,
          FIRSTMATE_BACKLOG: `${homeDirectory}/backlog.md`,
          FIRSTMATE_WATCH_STATE: stateDirectory
        },
        timeoutMs
      });
    } catch (error) {
      execError = error instanceof Error ? error.message : String(error);
    }
    const failed = execError !== undefined || execution === undefined || execution.timedOut || execution.exitCode !== 0;
    if (failed) {
      const reason = execError ?? (execution?.timedOut === true ? `timed out after ${timeoutMs} ms` : execution?.exitCode === null ? "was killed without an exit code" : `exited with code ${execution?.exitCode}`);
      runState.lastOutcome = "failed";
      runState.lastOutput = execution === undefined ? "" : presentOutput(execution.stdout.trim());
      if (runState.reportedFailure !== true) {
        runState.reportedFailure = true;
        notifications.push({
          slug,
          coordinatorSessionId,
          homeDirectory,
          message: `FirstMate (${slug}) watch ${watch.name} failed: ${reason}`
        });
      }
      return;
    }
    runState.reportedFailure = false;
    const output = presentOutput(execution.stdout.trim());
    if (output === "") {
      runState.lastOutcome = "empty";
      runState.lastOutput = "";
      return;
    }
    runState.lastOutcome = "ok";
    runState.lastOutput = output;
    notifications.push({
      slug,
      coordinatorSessionId,
      homeDirectory,
      message: `FirstMate (${slug}) watch ${watch.name}:
${output}`
    });
  }
  async function listWatches(slug) {
    const watches = await discoverWatches(slug);
    const enabledOverrides = await loadEnabledOverrides(slug);
    return watches.map((watch) => {
      const runState = runStates.get(stateKey(slug, watch.source, watch.name));
      return {
        name: watch.name,
        source: watch.source,
        schedule: watch.schedule,
        enabled: isEnabled(enabledOverrides, watch.source, watch.name),
        ...watch.error !== undefined ? { error: watch.error } : {},
        ...runState?.lastRunAt !== undefined ? { lastRunAt: runState.lastRunAt } : {},
        ...runState?.lastOutcome !== undefined ? { lastOutcome: runState.lastOutcome } : {},
        ...runState?.lastOutput !== undefined && runState.lastOutput !== "" ? { lastOutput: runState.lastOutput } : {}
      };
    });
  }
  async function setEnabled(slug, source, name, enabled) {
    const candidates = (await discoverWatches(slug)).filter((watch) => watch.name === name);
    const targets = source === undefined ? candidates : candidates.filter((watch) => watch.source === source);
    if (targets.length === 0)
      return "unknown-watch";
    if (targets.length > 1)
      return "ambiguous-watch";
    const target = targets[0];
    const settingsPath = `${homeRoot}/projects/${slug}/settings.json`;
    let settings = {};
    if (await filesystem.exists(settingsPath)) {
      let parsed;
      try {
        parsed = JSON.parse(await filesystem.readFile(settingsPath));
      } catch (error) {
        throw new WatchSettingsError(settingsPath, error instanceof Error ? error.message : "not valid JSON");
      }
      if (!isPlainObject2(parsed)) {
        throw new WatchSettingsError(settingsPath, "not a JSON object");
      }
      settings = parsed;
    }
    const stored = isPlainObject2(settings.watches) ? { ...settings.watches } : {};
    const forSource = isPlainObject2(stored[target.source]) ? { ...stored[target.source] } : {};
    const entry = isPlainObject2(forSource[name]) ? { ...forSource[name] } : {};
    entry.enabled = enabled;
    forSource[name] = entry;
    stored[target.source] = forSource;
    settings.watches = stored;
    const tempPath = `${settingsPath}.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
    await filesystem.writeFile(tempPath, `${JSON.stringify(settings, null, 2)}
`);
    await filesystem.rename(tempPath, settingsPath);
    return "ok";
  }
  return { tick, listWatches, setEnabled };
}
function isEnabled(overrides, source, name) {
  const entry = overrides[source]?.[name];
  return !(isPlainObject2(entry) && entry.enabled === false);
}
function isPlainObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function presentOutput(text) {
  if (text.length <= lastOutputMaxLength)
    return text;
  const dropped = text.length - lastOutputMaxLength;
  return `…[truncated ${dropped} chars]
${text.slice(-lastOutputMaxLength)}`;
}

// service/main.ts
var rawServicePort = process.env.OPENCHAMBER_SERVICE_PORT;
var serviceToken = process.env.OPENCHAMBER_SERVICE_TOKEN;
var homeRoot = process.env.FIRSTMATE_HOME ?? path2.join(homedir(), ".config", "firstmate");
var openchamberSettingsPath = process.env.FIRSTMATE_OPENCHAMBER_SETTINGS ?? path2.join(homedir(), ".config", "openchamber", "settings.json");
var templatesDirectory = path2.resolve(path2.dirname(process.argv[1] ?? "."), "..", "templates");
var servicePort = Number(rawServicePort);
if (!rawServicePort || !Number.isInteger(servicePort) || servicePort < 0) {
  throw new Error("OPENCHAMBER_SERVICE_PORT must be set to a valid port");
}
if (!serviceToken) {
  throw new Error("OPENCHAMBER_SERVICE_TOKEN must be set");
}
var nodeFileSystem = {
  exists: async (filePath) => {
    try {
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  },
  readFile: (filePath) => readFile(filePath, "utf8"),
  writeFile: (filePath, contents) => writeFile(filePath, contents, "utf8"),
  appendFile: (filePath, contents) => appendFile(filePath, contents, "utf8"),
  createDirectory: (directoryPath) => mkdir(directoryPath, { recursive: true }),
  rename: (fromPath, toPath) => rename(fromPath, toPath),
  listDirectories: async (directoryPath) => {
    try {
      const entries = await readdir(directoryPath, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  },
  listExecutableFiles: async (directoryPath) => {
    const names = [];
    let entries;
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (!entry.isFile())
        continue;
      try {
        await access(path2.join(directoryPath, entry.name), fsConstants.X_OK);
        names.push(entry.name);
      } catch {}
    }
    return names;
  },
  setExecutable: (filePath) => chmod(filePath, 493)
};
var nodeExec = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  child.on("error", reject);
  child.on("close", (code) => {
    if (code === 0) {
      resolve(Buffer.concat(stdoutChunks).toString("utf8"));
      return;
    }
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    reject(new Error(`${command} exited with code ${code}${stderr === "" ? "" : `: ${stderr}`}`));
  });
});
var nodeFetcher = (url, init) => fetch(url, init);
var watchOutputCapBytes = 256 * 1024;
var nodeWatchExec = ({ scriptPath, cwd, env, timeoutMs }) => new Promise((resolve, reject) => {
  const child = spawn(scriptPath, [], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const stdoutChunks = [];
  let totalBytes = 0;
  let tailBytes = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  child.stdout.on("data", (chunk) => {
    totalBytes += chunk.length;
    stdoutChunks.push(chunk);
    tailBytes += chunk.length;
    while (tailBytes > watchOutputCapBytes) {
      const overflow = tailBytes - watchOutputCapBytes;
      const first = stdoutChunks[0];
      if (first.length <= overflow) {
        stdoutChunks.shift();
        tailBytes -= first.length;
      } else {
        stdoutChunks[0] = first.subarray(overflow);
        tailBytes -= overflow;
      }
    }
  });
  child.on("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    const droppedHeadBytes = totalBytes - tailBytes;
    const kept = Buffer.concat(stdoutChunks).toString("utf8");
    resolve({
      stdout: droppedHeadBytes > 0 ? `…[truncated ${droppedHeadBytes} bytes]
${kept}` : kept,
      exitCode: code,
      timedOut
    });
  });
});
var templateReader = (templateName) => readFile(path2.join(templatesDirectory, templateName), "utf8");
var defaultPollIntervalMs = 15000;
var defaultWatchIntervalMs = 60000;
function readIntervalMs(env, fallback, name) {
  const raw = process.env[env];
  if (raw === undefined || raw.trim() === "")
    return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
function readPollIntervalMs() {
  return readIntervalMs("FIRSTMATE_POLL_MS", defaultPollIntervalMs, "FIRSTMATE_POLL_MS");
}
function readWatchIntervalMs() {
  return readIntervalMs("FIRSTMATE_WATCH_MS", defaultWatchIntervalMs, "FIRSTMATE_WATCH_MS");
}
var pollIntervalMs = readPollIntervalMs();
var watchIntervalMs = readWatchIntervalMs();
var clock = createNodeClock();
var supervisionPoller = createSupervisionPoller({ filesystem: nodeFileSystem, exec: nodeExec, homeRoot });
var watchRunner = createWatchRunner({ filesystem: nodeFileSystem, exec: nodeWatchExec, clock, homeRoot });
var roundInFlight = false;
async function runSupervisionRound() {
  if (roundInFlight)
    return;
  roundInFlight = true;
  try {
    const round = await supervisionPoller.poll();
    for (const notification of round.notifications) {
      try {
        await deliverNotification({ exec: nodeExec, clock, notification });
        supervisionPoller.clearDeliveryError(notification.slug);
      } catch (error) {
        supervisionPoller.recordDeliveryError(notification.slug, error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    roundInFlight = false;
  }
}
var watchRoundInFlight = false;
async function runWatchRound() {
  if (watchRoundInFlight)
    return;
  watchRoundInFlight = true;
  try {
    const round = await watchRunner.tick();
    for (const notification of round.notifications) {
      try {
        await deliverNotification({ exec: nodeExec, clock, notification });
      } catch {}
    }
  } catch {} finally {
    watchRoundInFlight = false;
  }
}
function isAuthorized(request) {
  return request.headers.authorization === `Bearer ${serviceToken}`;
}
function isRecord3(value) {
  return typeof value === "object" && value !== null;
}
function respondJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}
async function readJsonRecord(request) {
  try {
    const payload = await readJsonBody(request);
    return isRecord3(payload) ? payload : undefined;
  } catch {
    return;
  }
}
function recordString(record, key) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
async function readProjectDirectory(request) {
  let payload;
  try {
    payload = await readJsonBody(request);
  } catch {
    return;
  }
  const projectDirectory = isRecord3(payload) ? payload.projectDirectory : undefined;
  if (typeof projectDirectory !== "string" || projectDirectory.trim() === "") {
    return;
  }
  return projectDirectory;
}
async function handleProvision(request, response) {
  const projectDirectory = await readProjectDirectory(request);
  if (projectDirectory === undefined) {
    respondJson(response, 400, { error: "projectDirectory must be a non-empty string" });
    return;
  }
  try {
    const { slug, projectHomeDirectory } = await provisionProject({
      filesystem: nodeFileSystem,
      templateReader,
      homeRoot,
      projectDirectory
    });
    await composeInstructions({ filesystem: nodeFileSystem, homeRoot, slug });
    respondJson(response, 200, { slug, homeDirectory: projectHomeDirectory });
  } catch (error) {
    respondJson(response, 500, { error: error instanceof Error ? error.message : "provisioning failed" });
  }
}
async function handleLaunch(request, response) {
  const projectDirectory = await readProjectDirectory(request);
  if (projectDirectory === undefined) {
    respondJson(response, 400, { error: "projectDirectory must be a non-empty string" });
    return;
  }
  try {
    const { registration } = await launchFirstMate({
      filesystem: nodeFileSystem,
      exec: nodeExec,
      templateReader,
      homeRoot,
      projectDirectory
    });
    respondJson(response, 200, registration);
  } catch (error) {
    if (error instanceof MissingCliError) {
      respondJson(response, 503, { error: error.message, code: "cli-missing" });
      return;
    }
    respondJson(response, 500, { error: error instanceof Error ? error.message : "launch failed" });
  }
}
async function handleRegistryList(response) {
  const registrations = await loadRegistry(nodeFileSystem, homeRoot);
  respondJson(response, 200, { registrations: Object.values(registrations) });
}
async function handleRegistryItem(slug, response) {
  const registrations = await loadRegistry(nodeFileSystem, homeRoot);
  if (!Object.hasOwn(registrations, slug)) {
    respondJson(response, 404, { error: `no first mate registered for slug ${slug}` });
    return;
  }
  respondJson(response, 200, registrations[slug]);
}
async function handleLookup(url, response) {
  const directory = url.searchParams.get("directory");
  if (directory === null || directory.trim() === "") {
    respondJson(response, 400, { error: "directory must be a non-empty string" });
    return;
  }
  try {
    const registrations = await loadRegistry(nodeFileSystem, homeRoot);
    const registration = findRegistration(registrations, directory);
    respondJson(response, 200, { registration: registration ?? null });
  } catch (error) {
    respondJson(response, 500, { error: error instanceof Error ? error.message : "lookup failed" });
  }
}
async function handleBoard(url, response) {
  const slug = url.searchParams.get("slug");
  if (slug === null || slug.trim() === "") {
    respondJson(response, 400, { error: "slug must be a non-empty string" });
    return;
  }
  try {
    const registrations = await loadRegistry(nodeFileSystem, homeRoot);
    if (!Object.hasOwn(registrations, slug)) {
      respondJson(response, 404, { error: `no first mate registered for slug ${slug}` });
      return;
    }
    const backlog = await loadBacklog(nodeFileSystem, `${homeRoot}/projects/${slug}/backlog.md`);
    const archivedSessionIds = await loadArchivedSessionIds(nodeFileSystem, homeRoot, slug);
    const tasks = backlog.tasks.filter((task) => task.sessionId === undefined || !archivedSessionIds.has(task.sessionId));
    const workers = supervisionPoller.getBoardWorkers(slug, tasks);
    const deliveryError = supervisionPoller.getDeliveryError(slug);
    respondJson(response, 200, deliveryError === undefined ? { workers } : { workers, deliveryError });
  } catch (error) {
    respondJson(response, 500, { error: error instanceof Error ? error.message : "board read failed" });
  }
}
async function handleBacklog(url, response) {
  const slug = url.searchParams.get("slug");
  if (slug === null || slug.trim() === "") {
    respondJson(response, 400, { error: "slug must be a non-empty string" });
    return;
  }
  try {
    const registrations = await loadRegistry(nodeFileSystem, homeRoot);
    if (!Object.hasOwn(registrations, slug)) {
      respondJson(response, 404, { error: `no first mate registered for slug ${slug}` });
      return;
    }
    const backlog = await loadBacklog(nodeFileSystem, `${homeRoot}/projects/${slug}/backlog.md`);
    respondJson(response, 200, backlog);
  } catch (error) {
    respondJson(response, 500, { error: error instanceof Error ? error.message : "backlog read failed" });
  }
}
async function findProjectWorker(slug, sessionId) {
  const registrations = await loadRegistry(nodeFileSystem, homeRoot);
  if (!Object.hasOwn(registrations, slug))
    return { kind: "unknown-slug" };
  const registration = registrations[slug];
  const backlog = await loadBacklog(nodeFileSystem, `${homeRoot}/projects/${slug}/backlog.md`);
  const task = backlog.tasks.find((candidate) => candidate.sessionId === sessionId);
  return task === undefined ? { kind: "unknown-task" } : { kind: "found", registration, task };
}
function respondWorkerContextMissing(response, context, slug, sessionId) {
  if (context.kind === "unknown-slug") {
    respondJson(response, 404, { error: `no first mate registered for slug ${slug}` });
    return;
  }
  respondJson(response, 404, { error: `no worker with session id ${sessionId} on ${slug}'s backlog` });
}
function respondActionError(response, error, fallback) {
  if (error instanceof MissingCliError) {
    respondJson(response, 503, { error: error.message, code: "cli-missing" });
    return;
  }
  respondJson(response, 500, { error: error instanceof Error ? error.message : fallback });
}
async function handleSteer(request, response) {
  const payload = await readJsonRecord(request);
  const slug = recordString(payload, "slug");
  const sessionId = recordString(payload, "sessionId");
  const text = recordString(payload, "text");
  if (slug === undefined || sessionId === undefined || text === undefined) {
    respondJson(response, 400, { error: "slug, sessionId, and text must be non-empty strings" });
    return;
  }
  try {
    const context = await findProjectWorker(slug, sessionId);
    if (context.kind !== "found") {
      respondWorkerContextMissing(response, context, slug, sessionId);
      return;
    }
    const archivedSessionIds = await loadArchivedSessionIds(nodeFileSystem, homeRoot, slug);
    if (archivedSessionIds.has(sessionId)) {
      respondJson(response, 409, { error: `the worker with session id ${sessionId} is archived` });
      return;
    }
    const outcome = await steerWorker({
      exec: nodeExec,
      worker: { sessionId, title: context.task.title },
      workerDirectory: context.registration.projectDirectory,
      coordinator: { sessionId: context.registration.coordinatorSessionId, directory: context.registration.homeDirectory },
      text
    });
    supervisionPoller.markSteered(slug, sessionId);
    if (outcome.coordinatorNotified) {
      respondJson(response, 200, { sent: true });
      return;
    }
    respondJson(response, 200, {
      sent: true,
      warning: `steered the worker, but could not tell the coordinator: ${outcome.coordinatorError}`
    });
  } catch (error) {
    respondActionError(response, error, "steer failed");
  }
}
async function handleRelaunch(request, response) {
  const payload = await readJsonRecord(request);
  const slug = recordString(payload, "slug");
  const sessionId = recordString(payload, "sessionId");
  const note = recordString(payload, "note");
  if (slug === undefined || sessionId === undefined || note === undefined) {
    respondJson(response, 400, { error: "slug, sessionId, and note must be non-empty strings" });
    return;
  }
  try {
    const context = await findProjectWorker(slug, sessionId);
    if (context.kind !== "found") {
      respondWorkerContextMissing(response, context, slug, sessionId);
      return;
    }
    const archivedSessionIds = await loadArchivedSessionIds(nodeFileSystem, homeRoot, slug);
    if (archivedSessionIds.has(sessionId)) {
      respondJson(response, 409, { error: `the worker with session id ${sessionId} is archived` });
      return;
    }
    if (context.task.worktreeDirectory === undefined) {
      respondJson(response, 400, { error: `the worker "${context.task.title}" has no worktree directory recorded in the backlog` });
      return;
    }
    await requestRelaunch({
      exec: nodeExec,
      worker: { sessionId, title: context.task.title },
      worktreeDirectory: context.task.worktreeDirectory,
      coordinator: { sessionId: context.registration.coordinatorSessionId, directory: context.registration.homeDirectory },
      note
    });
    respondJson(response, 200, { requested: true });
  } catch (error) {
    respondActionError(response, error, "relaunch failed");
  }
}
async function handleInterrupt(request, response) {
  const payload = await readJsonRecord(request);
  const slug = recordString(payload, "slug");
  const sessionId = recordString(payload, "sessionId");
  if (slug === undefined || sessionId === undefined) {
    respondJson(response, 400, { error: "slug and sessionId must be non-empty strings" });
    return;
  }
  try {
    const context = await findProjectWorker(slug, sessionId);
    if (context.kind !== "found") {
      respondWorkerContextMissing(response, context, slug, sessionId);
      return;
    }
    const archivedSessionIds = await loadArchivedSessionIds(nodeFileSystem, homeRoot, slug);
    if (archivedSessionIds.has(sessionId)) {
      respondJson(response, 409, { error: `the worker with session id ${sessionId} is archived` });
      return;
    }
    const support = await discoverSupport({ filesystem: nodeFileSystem, settingsPath: openchamberSettingsPath });
    const outcome = await interruptWorker({
      fetcher: nodeFetcher,
      support,
      sessionId,
      directory: context.registration.projectDirectory
    });
    if (outcome.kind === "ok") {
      respondJson(response, 200, { interrupted: true });
      return;
    }
    if (outcome.kind === "unsupported") {
      respondJson(response, 501, { error: "interrupt is not supported on this host", detail: outcome.reason });
      return;
    }
    respondJson(response, 502, { error: "the abort call failed", detail: outcome.message });
  } catch (error) {
    respondJson(response, 500, { error: error instanceof Error ? error.message : "interrupt failed" });
  }
}
async function handleWatchesList(url, response) {
  const slug = url.searchParams.get("slug");
  if (slug === null || slug.trim() === "") {
    respondJson(response, 400, { error: "slug must be a non-empty string" });
    return;
  }
  try {
    const registrations = await loadRegistry(nodeFileSystem, homeRoot);
    if (!Object.hasOwn(registrations, slug)) {
      respondJson(response, 404, { error: `no first mate registered for slug ${slug}` });
      return;
    }
    const watches = await watchRunner.listWatches(slug);
    respondJson(response, 200, { watches });
  } catch (error) {
    respondJson(response, 500, { error: error instanceof Error ? error.message : "watches read failed" });
  }
}
async function handleWatchesToggle(request, response) {
  const payload = await readJsonRecord(request);
  const slug = recordString(payload, "slug");
  const name = recordString(payload, "name");
  const enabled = payload?.enabled;
  const source = payload?.source;
  if (slug === undefined || name === undefined || typeof enabled !== "boolean") {
    respondJson(response, 400, { error: "slug and name must be non-empty strings and enabled a boolean" });
    return;
  }
  if (source !== undefined && source !== "shared" && source !== "project") {
    respondJson(response, 400, { error: `source must be "shared" or "project" when given` });
    return;
  }
  try {
    const registrations = await loadRegistry(nodeFileSystem, homeRoot);
    if (!Object.hasOwn(registrations, slug)) {
      respondJson(response, 404, { error: `no first mate registered for slug ${slug}` });
      return;
    }
    const result = await watchRunner.setEnabled(slug, source, name, enabled);
    if (result === "unknown-watch") {
      respondJson(response, 404, { error: `no watch named ${name} for slug ${slug}` });
      return;
    }
    if (result === "ambiguous-watch") {
      respondJson(response, 409, {
        error: `the watch name ${name} matches both a shared and a project watch for ${slug}; pass source "shared" or "project"`
      });
      return;
    }
    respondJson(response, 200, { toggled: true, name, enabled });
  } catch (error) {
    respondJson(response, 500, { error: error instanceof Error ? error.message : "watch toggle failed" });
  }
}
async function handleEnd(request, response) {
  const payload = await readJsonRecord(request);
  const slug = recordString(payload, "slug");
  const sessionId = recordString(payload, "sessionId");
  if (slug === undefined || sessionId === undefined) {
    respondJson(response, 400, { error: "slug and sessionId must be non-empty strings" });
    return;
  }
  try {
    const context = await findProjectWorker(slug, sessionId);
    if (context.kind !== "found") {
      respondWorkerContextMissing(response, context, slug, sessionId);
      return;
    }
    const archivedSessionIds = await loadArchivedSessionIds(nodeFileSystem, homeRoot, slug);
    if (!archivedSessionIds.has(sessionId)) {
      await archiveSession(nodeFileSystem, homeRoot, slug, {
        sessionId,
        title: context.task.title,
        archivedAt: new Date(clock.nowMs()).toISOString()
      });
    }
    respondJson(response, 200, { archived: true });
  } catch (error) {
    respondJson(response, 500, { error: error instanceof Error ? error.message : "archive failed" });
  }
}
async function handleShipping(url, response) {
  const slug = url.searchParams.get("slug");
  if (slug === null || slug.trim() === "") {
    respondJson(response, 400, { error: "slug must be a non-empty string" });
    return;
  }
  try {
    const registrations = await loadRegistry(nodeFileSystem, homeRoot);
    if (!Object.hasOwn(registrations, slug)) {
      respondJson(response, 404, { error: `no first mate registered for slug ${slug}` });
      return;
    }
    const projectsMdPath = `${homeRoot}/projects/${slug}/projects.md`;
    const shipping = await nodeFileSystem.exists(projectsMdPath) ? parseShippingMode(await nodeFileSystem.readFile(projectsMdPath)) : { mode: null, yolo: false };
    const landings = await loadLandingRecords(nodeFileSystem, homeRoot, slug);
    respondJson(response, 200, {
      mode: shipping.mode,
      yolo: shipping.yolo,
      landings: landings.records.slice(-20)
    });
  } catch (error) {
    respondJson(response, 500, { error: error instanceof Error ? error.message : "shipping read failed" });
  }
}
async function resolveSuggestion(slug, label) {
  const registrations = await loadRegistry(nodeFileSystem, homeRoot);
  if (!Object.hasOwn(registrations, slug))
    return { kind: "unknown-slug" };
  const suggestions = await loadSuggestions(nodeFileSystem, suggestionsPath(homeRoot, slug));
  const suggestion = suggestions.find((candidate) => candidate.label === label);
  return suggestion === undefined ? { kind: "unknown-label" } : { kind: "found", registration: registrations[slug], suggestion };
}
async function handleSuggestions(url, response) {
  const slug = url.searchParams.get("slug");
  if (slug === null || slug.trim() === "") {
    respondJson(response, 400, { error: "slug must be a non-empty string" });
    return;
  }
  try {
    const registrations = await loadRegistry(nodeFileSystem, homeRoot);
    if (!Object.hasOwn(registrations, slug)) {
      respondJson(response, 404, { error: `no first mate registered for slug ${slug}` });
      return;
    }
    const suggestions = await loadSuggestions(nodeFileSystem, suggestionsPath(homeRoot, slug));
    respondJson(response, 200, { suggestions });
  } catch (error) {
    respondJson(response, 500, { error: error instanceof Error ? error.message : "suggestions read failed" });
  }
}
async function handleSuggestionSend(request, response) {
  const payload = await readJsonRecord(request);
  const slug = recordString(payload, "slug");
  const label = recordString(payload, "label");
  if (slug === undefined || label === undefined) {
    respondJson(response, 400, { error: "slug and label must be non-empty strings" });
    return;
  }
  try {
    const context = await resolveSuggestion(slug, label);
    if (context.kind === "unknown-slug") {
      respondJson(response, 404, { error: `no first mate registered for slug ${slug}` });
      return;
    }
    if (context.kind === "unknown-label") {
      respondJson(response, 404, { error: `no suggestion labeled "${label}" on ${slug}'s suggestions.md` });
      return;
    }
    await sendCoordinatorMessage({
      exec: nodeExec,
      coordinator: {
        sessionId: context.registration.coordinatorSessionId,
        directory: context.registration.homeDirectory
      },
      text: context.suggestion.text
    });
    await removeSuggestion(nodeFileSystem, suggestionsPath(homeRoot, slug), label);
    respondJson(response, 200, { sent: true });
  } catch (error) {
    respondActionError(response, error, "suggestion send failed");
  }
}
async function handleSuggestionDismiss(request, response) {
  const payload = await readJsonRecord(request);
  const slug = recordString(payload, "slug");
  const label = recordString(payload, "label");
  if (slug === undefined || label === undefined) {
    respondJson(response, 400, { error: "slug and label must be non-empty strings" });
    return;
  }
  try {
    const context = await resolveSuggestion(slug, label);
    if (context.kind === "unknown-slug") {
      respondJson(response, 404, { error: `no first mate registered for slug ${slug}` });
      return;
    }
    if (context.kind === "unknown-label") {
      respondJson(response, 404, { error: `no suggestion labeled "${label}" on ${slug}'s suggestions.md` });
      return;
    }
    await removeSuggestion(nodeFileSystem, suggestionsPath(homeRoot, slug), label);
    respondJson(response, 200, { dismissed: true });
  } catch (error) {
    respondJson(response, 500, { error: error instanceof Error ? error.message : "suggestion dismiss failed" });
  }
}
var commandPrompts = {
  bearings: "/bearings",
  "bearings-file": "/bearings file",
  ahoy: "/ahoy"
};
async function handleCommand(request, response) {
  const payload = await readJsonRecord(request);
  const slug = recordString(payload, "slug");
  const command = recordString(payload, "command");
  if (slug === undefined || command === undefined) {
    respondJson(response, 400, { error: "slug and command must be non-empty strings" });
    return;
  }
  const prompt = commandPrompts[command];
  if (prompt === undefined) {
    respondJson(response, 400, { error: `unknown command "${command}"` });
    return;
  }
  try {
    const registrations = await loadRegistry(nodeFileSystem, homeRoot);
    if (!Object.hasOwn(registrations, slug)) {
      respondJson(response, 404, { error: `no first mate registered for slug ${slug}` });
      return;
    }
    const registration = registrations[slug];
    await sendCoordinatorMessage({
      exec: nodeExec,
      coordinator: { sessionId: registration.coordinatorSessionId, directory: registration.homeDirectory },
      text: prompt
    });
    respondJson(response, 200, { sent: true });
  } catch (error) {
    respondActionError(response, error, "command send failed");
  }
}
async function handleRequest(request, response) {
  if (!isAuthorized(request)) {
    respondJson(response, 401, { error: "unauthorized" });
    return;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;
  if (request.method === "GET" && pathname === "/health") {
    respondJson(response, 200, { status: "ok" });
    return;
  }
  if (request.method === "POST" && pathname === "/provision") {
    await handleProvision(request, response);
    return;
  }
  if (request.method === "POST" && pathname === "/launch") {
    await handleLaunch(request, response);
    return;
  }
  if (request.method === "GET" && pathname === "/registry") {
    await handleRegistryList(response);
    return;
  }
  if (request.method === "GET" && pathname.startsWith("/registry/")) {
    const slug = decodeURIComponent(pathname.slice("/registry/".length));
    if (slug !== "") {
      await handleRegistryItem(slug, response);
      return;
    }
  }
  if (request.method === "GET" && pathname === "/lookup") {
    await handleLookup(url, response);
    return;
  }
  if (request.method === "GET" && pathname === "/backlog") {
    await handleBacklog(url, response);
    return;
  }
  if (request.method === "GET" && pathname === "/board") {
    await handleBoard(url, response);
    return;
  }
  if (request.method === "GET" && pathname === "/watches") {
    await handleWatchesList(url, response);
    return;
  }
  if (request.method === "GET" && pathname === "/shipping") {
    await handleShipping(url, response);
    return;
  }
  if (request.method === "GET" && pathname === "/suggestions") {
    await handleSuggestions(url, response);
    return;
  }
  if (request.method === "POST" && pathname === "/suggestion/send") {
    await handleSuggestionSend(request, response);
    return;
  }
  if (request.method === "POST" && pathname === "/suggestion/dismiss") {
    await handleSuggestionDismiss(request, response);
    return;
  }
  if (request.method === "POST" && pathname === "/command") {
    await handleCommand(request, response);
    return;
  }
  if (request.method === "POST" && pathname === "/watches/toggle") {
    await handleWatchesToggle(request, response);
    return;
  }
  if (request.method === "POST" && pathname === "/steer") {
    await handleSteer(request, response);
    return;
  }
  if (request.method === "POST" && pathname === "/relaunch") {
    await handleRelaunch(request, response);
    return;
  }
  if (request.method === "POST" && pathname === "/interrupt") {
    await handleInterrupt(request, response);
    return;
  }
  if (request.method === "POST" && pathname === "/end") {
    await handleEnd(request, response);
    return;
  }
  response.statusCode = 404;
  response.end();
}
var server = createServer((request, response) => {
  handleRequest(request, response).catch(() => {
    if (!response.writableEnded) {
      respondJson(response, 500, { error: "internal error" });
    }
  });
});
server.listen(servicePort, "127.0.0.1");
var pollTimer = clock.startInterval(() => {
  runSupervisionRound();
}, pollIntervalMs);
var watchTimer = clock.startInterval(() => {
  runWatchRound();
}, watchIntervalMs);
function stopService() {
  pollTimer.cancel();
  watchTimer.cancel();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGTERM", stopService);
process.on("SIGINT", stopService);
