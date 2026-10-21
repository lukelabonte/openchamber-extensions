#!/usr/bin/env node

// service/tell.ts
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path2 from "node:path";
import { pathToFileURL } from "node:url";

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

// service/slug.ts
import path from "node:path";
function normalizeProjectDirectory(projectDirectory) {
  return path.resolve(projectDirectory.trim());
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
function findRegistration(registrations, projectDirectory) {
  const normalizedDirectory = normalizeProjectDirectory(projectDirectory);
  return Object.values(registrations).find((registration) => normalizeProjectDirectory(registration.projectDirectory) === normalizedDirectory || normalizeProjectDirectory(registration.homeDirectory) === normalizedDirectory);
}
function isRegistration(value) {
  if (!isPlainObject(value))
    return false;
  return typeof value.slug === "string" && typeof value.projectDirectory === "string" && typeof value.homeDirectory === "string" && typeof value.coordinatorSessionId === "string" && typeof value.createdAt === "string";
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// service/handoff.ts
async function resolveProjectRegistration(filesystem, homeRoot, directory) {
  const registrations = await loadRegistry(filesystem, homeRoot);
  const direct = findRegistration(registrations, directory);
  if (direct !== undefined)
    return direct;
  const normalizedDirectory = normalizeProjectDirectory(directory);
  const matches = [];
  for (const registration of Object.values(registrations)) {
    const backlogPath = `${registration.homeDirectory}/backlog.md`;
    if (!await filesystem.exists(backlogPath))
      continue;
    const backlog = await loadBacklog(filesystem, backlogPath);
    if (backlog.tasks.some((task) => task.worktreeDirectory !== undefined && normalizeProjectDirectory(task.worktreeDirectory) === normalizedDirectory))
      matches.push(registration);
  }
  if (matches.length > 1)
    throw new Error("This worktree belongs to more than one FirstMate backlog; resolve the conflicting records first.");
  return matches[0];
}
async function handoffToFirstMate(input) {
  if (typeof input.text !== "string" || input.text.trim() === "" || Buffer.byteLength(input.text, "utf8") > 12000)
    throw new Error("A FirstMate handoff needs non-empty text of at most 12,000 UTF-8 bytes.");
  const registration = await resolveProjectRegistration(input.filesystem, input.homeRoot, input.directory);
  if (registration === undefined)
    throw new Error("No first mate is registered for this directory. Launch one from the project's FirstMate panel.");
  const origin = input.sessionId === undefined ? "a terminal or script" : `session ${input.sessionId.replace(/\s+/g, " ")}, as claimed by the sender`;
  const directory = input.directory.replace(/\s+/g, " ");
  await sessionSend(input.exec, {
    sessionId: registration.coordinatorSessionId,
    directory: registration.homeDirectory,
    prompt: `Relayed to FirstMate, from ${origin} (${directory}). This is a work request, not merge approval. Keep a durable captain-approval hold on work this request starts or steers, even under +yolo.

${input.text}`
  });
}

// service/tell.ts
var maximumRequestBytes = 12000;
var helpText = `Usage: tell [--dir PATH] [--session ID] [--stdin] [--] request words

Relay a work request to the registered FirstMate for PATH (default: cwd),
or the project that records PATH as a worktree. No other project is inferred.
--stdin       Read exact UTF-8 text from stdin, up to 12,000 bytes.
--session ID  Label the origin as a session claimed by the sender.
--help        Show this help without reading files, stdin, or running commands.

Requests are not merge approval; a durable captain-approval hold remains required.
`;
function parseTellArguments(argumentsList) {
  const parsed = { help: false, stdin: false, words: [] };
  let help = false;
  let positionalOnly = false;
  for (let index = 0;index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (!positionalOnly && argument === "--") {
      positionalOnly = true;
    } else if (!positionalOnly && argument === "--help") {
      help = true;
    } else if (!positionalOnly && (argument === "--dir" || argument === "--session")) {
      const value = argumentsList[index + 1];
      if (value === undefined || value.startsWith("-") || value.trim() === "" || value.includes("\x00"))
        throw new Error(`${argument} needs a non-empty value.`);
      const key = argument === "--dir" ? "directory" : "sessionId";
      if (parsed[key] !== undefined)
        throw new Error(`${argument} can be supplied only once.`);
      parsed[key] = value;
      index += 1;
    } else if (!positionalOnly && argument === "--stdin") {
      if (parsed.stdin)
        throw new Error("--stdin can be supplied only once.");
      parsed.stdin = true;
    } else if (!positionalOnly && argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}. Use --help for usage or -- before literal request words.`);
    } else {
      parsed.words.push(argument);
    }
  }
  if (help)
    return { help: true };
  if (parsed.stdin && parsed.words.length > 0)
    throw new Error("Use either --stdin or positional request words, not both.");
  return parsed;
}
async function readTellStdin(stdin) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of stdin) {
    totalBytes += chunk.byteLength;
    if (totalBytes > maximumRequestBytes)
      throw new Error("A FirstMate handoff can contain at most 12,000 UTF-8 bytes.");
    chunks.push(Buffer.from(chunk));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new Error("--stdin must contain valid UTF-8 text.");
  }
}
async function runTell(argumentsList, ports) {
  const argumentsParsed = parseTellArguments(argumentsList);
  if (argumentsParsed.help === true)
    return helpText;
  const text = argumentsParsed.stdin ? await readTellStdin(ports.stdin()) : argumentsParsed.words.join(" ");
  if (text.trim() === "")
    throw new Error("A FirstMate handoff needs non-empty request text.");
  if (Buffer.byteLength(text, "utf8") > maximumRequestBytes)
    throw new Error("A FirstMate handoff can contain at most 12,000 UTF-8 bytes.");
  if (text.includes("\x00"))
    throw new Error("A FirstMate handoff cannot contain NUL bytes because the CLI sends it as an argument.");
  const directory = path2.resolve(ports.cwd(), argumentsParsed.directory ?? ".");
  await handoffToFirstMate({ filesystem: ports.filesystem, exec: ports.exec, homeRoot: ports.homeRoot(), directory, text, ...argumentsParsed.sessionId === undefined ? {} : { sessionId: argumentsParsed.sessionId } });
  return `Request relayed to FirstMate; merge approval is still required.
`;
}
function createReadonlyFileSystemPort(homeRoot) {
  const root = path2.resolve(homeRoot);
  async function openRecord(filePath) {
    const recordPath = path2.resolve(filePath);
    const relativePath = path2.relative(root, recordPath);
    if (relativePath !== "registry.json" && !/^projects\/[^/]+\/backlog\.md$/.test(relativePath))
      throw new Error("FirstMate tell reads only its registry or project backlog files.");
    const [canonicalRoot, canonicalParent] = await Promise.all([realpath(root), realpath(path2.dirname(recordPath))]);
    if (canonicalParent !== path2.dirname(path2.join(canonicalRoot, relativePath)))
      throw new Error("FirstMate tell cannot read a record through a redirected project directory.");
    const file = await open(path2.join(canonicalParent, path2.basename(recordPath)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile())
        throw new Error("A FirstMate registry or backlog must be a regular file.");
      return file;
    } catch (error) {
      await file.close();
      throw error;
    }
  }
  const unavailable = async () => {
    throw new Error("FirstMate tell uses a read-only filesystem; this operation is unavailable.");
  };
  return {
    exists: async (filePath) => {
      try {
        const file = await openRecord(filePath);
        await file.close();
        return true;
      } catch (error) {
        if (error.code === "ENOENT")
          return false;
        throw error;
      }
    },
    readFile: async (filePath) => {
      const file = await openRecord(filePath);
      try {
        return await file.readFile("utf8");
      } finally {
        await file.close();
      }
    },
    writeFile: unavailable,
    appendFile: unavailable,
    createDirectory: unavailable,
    listDirectories: unavailable,
    listExecutableFiles: unavailable,
    setExecutable: unavailable,
    rename: unavailable
  };
}
var openchamberExec = (command, args) => new Promise((resolve, reject) => {
  if (command !== "openchamber") {
    reject(new Error("FirstMate tell can run only the openchamber CLI."));
    return;
  }
  const child = spawn("openchamber", [...args], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  child.on("error", (error) => reject(new Error(`Could not run openchamber: ${error.message}`)));
  child.on("close", (code, signal) => {
    if (code === 0) {
      resolve(Buffer.concat(stdoutChunks).toString("utf8"));
    } else {
      const detail = Buffer.concat(stderrChunks).toString("utf8").trim();
      reject(new Error(`openchamber exited ${signal === null ? `with code ${code}` : `after ${signal}`}${detail === "" ? "." : `: ${detail}`}`));
    }
  });
});
async function tellCli() {
  const argumentsList = process.argv.slice(2);
  if (parseTellArguments(argumentsList).help) {
    process.stdout.write(helpText);
    return;
  }
  const homeRoot = process.env.FIRSTMATE_HOME ?? path2.join(homedir(), ".config", "firstmate");
  const result = await runTell(argumentsList, {
    filesystem: createReadonlyFileSystemPort(homeRoot),
    exec: openchamberExec,
    homeRoot: () => homeRoot,
    cwd: () => process.cwd(),
    stdin: () => process.stdin
  });
  process.stdout.write(result);
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path2.resolve(process.argv[1])).href) {
  tellCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "FirstMate handoff failed."}
`);
    process.exitCode = 1;
  });
}
export {
  createReadonlyFileSystemPort,
  parseTellArguments,
  readTellStdin,
  runTell
};
