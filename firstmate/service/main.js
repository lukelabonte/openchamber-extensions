// service/main.ts
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path2 from "node:path";

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

// service/control-client.ts
class MissingCliError extends Error {
  constructor() {
    super("the openchamber CLI is required. Install it with: npm i -g @openchamber/web");
    this.name = "MissingCliError";
  }
}
async function createSession(exec, input) {
  let output;
  try {
    output = await exec("openchamber", ["session", "create", "--dir", input.directory, "--title", input.title, "--json"]);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new MissingCliError;
    }
    throw error;
  }
  const parsed = parseJsonOutput(output);
  const sessionId = extractSessionId(parsed);
  if (sessionId === undefined) {
    throw new Error("openchamber session create output did not include a session id");
  }
  return sessionId;
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
function isRecord(value) {
  return typeof value === "object" && value !== null;
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
  { templateName: "captain.md", fileName: "captain.md" }
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

// service/main.ts
var rawServicePort = process.env.OPENCHAMBER_SERVICE_PORT;
var serviceToken = process.env.OPENCHAMBER_SERVICE_TOKEN;
var homeRoot = process.env.FIRSTMATE_HOME ?? path2.join(homedir(), ".config", "firstmate");
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
  createDirectory: (directoryPath) => mkdir(directoryPath, { recursive: true }),
  rename: (fromPath, toPath) => rename(fromPath, toPath),
  listDirectories: async (directoryPath) => {
    try {
      const entries = await readdir(directoryPath, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  }
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
var templateReader = (templateName) => readFile(path2.join(templatesDirectory, templateName), "utf8");
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
  response.statusCode = 404;
  response.end();
}
createServer((request, response) => {
  handleRequest(request, response).catch(() => {
    if (!response.writableEnded) {
      respondJson(response, 500, { error: "internal error" });
    }
  });
}).listen(servicePort, "127.0.0.1");
