// service/main.ts
import { createServer } from "node:http";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path2 from "node:path";

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
    if (isRecord(settings) && settings.projectDirectory === projectDirectory) {
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
function isRecord(value) {
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
  listDirectories: async (directoryPath) => {
    try {
      const entries = await readdir(directoryPath, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  }
};
var templateReader = (templateName) => readFile(path2.join(templatesDirectory, templateName), "utf8");
function isAuthorized(request) {
  return request.headers.authorization === `Bearer ${serviceToken}`;
}
function isRecord2(value) {
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
async function handleProvision(request, response) {
  let payload;
  try {
    payload = await readJsonBody(request);
  } catch {
    respondJson(response, 400, { error: "request body must be JSON" });
    return;
  }
  const projectDirectory = isRecord2(payload) ? payload.projectDirectory : undefined;
  if (typeof projectDirectory !== "string" || projectDirectory.trim() === "") {
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
async function handleRequest(request, response) {
  if (!isAuthorized(request)) {
    respondJson(response, 401, { error: "unauthorized" });
    return;
  }
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method === "GET" && pathname === "/health") {
    respondJson(response, 200, { status: "ok" });
    return;
  }
  if (request.method === "POST" && pathname === "/provision") {
    await handleProvision(request, response);
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
