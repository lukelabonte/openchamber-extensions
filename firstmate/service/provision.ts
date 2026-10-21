import type { FileSystemPort } from "./file-system"
import { deriveSlug, normalizeProjectDirectory } from "./slug"
import { syncTemplateCopy } from "./template-upgrades"

interface ProvisionProjectInput {
  filesystem: FileSystemPort
  templateReader: (templateName: string) => Promise<string>
  homeRoot: string
  projectDirectory: string
}

interface ProvisionedProject {
  slug: string
  projectHomeDirectory: string
}

interface HomeFile {
  templateName: string
  fileName: string
  /** Executable watch scripts are installed with the exec bit set. */
  executable?: boolean
  /** Only shipped shared defaults opt into provenance-aware upgrades. */
  legacyHashes?: readonly string[]
}

const sharedDirectories = ["watches"]

export const legacyTemplateHashes = {
  charter: ["44c30fc03a72d0e3db47f520f77e9d2f256a8595da0c4a92a3613ba8d0bf4bd9", "f2a01f5f4d7e76a63bd026ebda14ecceee56c266aa2c8547af3e8b1430bf7c5b", "26ec3644f04dd682108b932ce183734b3dcaf9bba607c402da7adfde985d5d3b"],
  "pr-watch": ["436ce74feaf4fcb7beaeca787e30b0434ed2a5feeb0e4222540852c6b103fbbe"],
}

const sharedFiles: HomeFile[] = [
  { templateName: "charter.md", fileName: "charter.md", legacyHashes: legacyTemplateHashes.charter },
  { templateName: "captain.md", fileName: "captain.md" },
  { templateName: "watches-README.md", fileName: "watches/README.md" },
  { templateName: "pr-watch", fileName: "watches/pr-watch", executable: true, legacyHashes: legacyTemplateHashes["pr-watch"] },
]

const projectDirectories = ["briefs", "reports", "watches"]

const projectFiles: HomeFile[] = [
  { templateName: "project-charter.md", fileName: "charter.md" },
  { templateName: "captain.md", fileName: "captain.md" },
  { templateName: "backlog.md", fileName: "backlog.md" },
  { templateName: "projects.md", fileName: "projects.md" },
  { templateName: "opening-note.md", fileName: "opening.md" },
  { templateName: "learnings.md", fileName: "learnings.md" },
]

export async function provisionProject(input: ProvisionProjectInput): Promise<ProvisionedProject> {
  const { filesystem, templateReader, homeRoot, projectDirectory } = input
  const normalizedDirectory = normalizeProjectDirectory(projectDirectory)
  const projectsRoot = `${homeRoot}/projects`
  const homeNames = await filesystem.listDirectories(projectsRoot)
  const matchedHome = await findProjectHomeSlug({ filesystem, projectsRoot, homeNames, projectDirectory: normalizedDirectory })
  const existingProjectDirectories = homeNames.map((name) => `${projectsRoot}/${name}`)
  const slug = matchedHome ?? deriveSlug(normalizedDirectory, existingProjectDirectories)
  const projectHomeDirectory = `${projectsRoot}/${slug}`

  await filesystem.createDirectory(`${homeRoot}/shared`)
  await filesystem.createDirectory(projectHomeDirectory)
  await createFiles({
    filesystem,
    templateReader,
    parentDirectory: `${homeRoot}/shared`,
    directories: sharedDirectories,
    files: sharedFiles,
  })
  await createFiles({
    filesystem,
    templateReader,
    parentDirectory: projectHomeDirectory,
    directories: projectDirectories,
    files: projectFiles,
  })
  if (matchedHome === undefined) {
    await writeSettingsAssociation({
      filesystem,
      templateReader,
      settingsPath: `${projectHomeDirectory}/settings.json`,
      projectDirectory: normalizedDirectory,
    })
  }

  return { slug, projectHomeDirectory }
}

async function findProjectHomeSlug(input: {
  filesystem: FileSystemPort
  projectsRoot: string
  homeNames: readonly string[]
  projectDirectory: string
}): Promise<string | undefined> {
  const { filesystem, projectsRoot, homeNames, projectDirectory } = input
  for (const homeName of homeNames) {
    const settingsPath = `${projectsRoot}/${homeName}/settings.json`
    if (!(await filesystem.exists(settingsPath))) continue
    let settings: unknown
    try {
      settings = JSON.parse(await filesystem.readFile(settingsPath))
    } catch {
      continue
    }
    if (isRecord(settings) && settings.projectDirectory === projectDirectory) {
      return homeName
    }
  }
  return undefined
}

async function writeSettingsAssociation(input: {
  filesystem: FileSystemPort
  templateReader: (templateName: string) => Promise<string>
  settingsPath: string
  projectDirectory: string
}): Promise<void> {
  const settings = JSON.parse(await input.templateReader("settings.json")) as Record<string, unknown>
  settings.projectDirectory = input.projectDirectory
  await input.filesystem.writeFile(input.settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function createFiles(input: {
  filesystem: FileSystemPort
  templateReader: (templateName: string) => Promise<string>
  parentDirectory: string
  directories: readonly string[]
  files: readonly HomeFile[]
}): Promise<void> {
  const { filesystem, templateReader, parentDirectory, directories, files } = input
  for (const directory of directories) {
    await filesystem.createDirectory(`${parentDirectory}/${directory}`)
  }
  for (const file of files) {
    const filePath = `${parentDirectory}/${file.fileName}`
    if (file.legacyHashes !== undefined) {
      const state = await syncTemplateCopy({ filesystem, filePath, contents: await templateReader(file.templateName), legacyHashes: file.legacyHashes })
      if (file.executable === true && !state.edited && !state.outdated) await filesystem.setExecutable(filePath)
      continue
    }
    if (await filesystem.exists(filePath)) continue
    await filesystem.writeFile(filePath, await templateReader(file.templateName))
    if (file.executable === true) await filesystem.setExecutable(filePath)
  }
}
