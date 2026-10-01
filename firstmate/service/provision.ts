import type { FileSystemPort } from "./file-system"
import { deriveSlug, normalizeProjectDirectory } from "./slug"

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
}

const sharedDirectories = ["watches"]

const sharedFiles: HomeFile[] = [
  { templateName: "charter.md", fileName: "charter.md" },
  { templateName: "captain.md", fileName: "captain.md" },
]

const projectDirectories = ["briefs", "reports", "watches"]

const projectFiles: HomeFile[] = [
  { templateName: "project-charter.md", fileName: "charter.md" },
  { templateName: "captain.md", fileName: "captain.md" },
  { templateName: "backlog.md", fileName: "backlog.md" },
  { templateName: "projects.md", fileName: "projects.md" },
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
    if (await filesystem.exists(filePath)) continue
    await filesystem.writeFile(filePath, await templateReader(file.templateName))
  }
}
