import type { FileSystemPort } from "./file-system"
import { randomUUID } from "node:crypto"
import { loadProjectSettings } from "./settings"

interface ComposeInstructionsInput {
  filesystem: FileSystemPort
  homeRoot: string
  slug: string
}

interface ComposedLayer {
  relativePath: string
  contents: string | undefined
}

export async function composeInstructions(input: ComposeInstructionsInput): Promise<string> {
  const { filesystem, homeRoot, slug } = input
  const relativePaths = [
    "shared/charter.md",
    `projects/${slug}/charter.md`,
    "shared/captain.md",
    `projects/${slug}/captain.md`,
  ]
  const layers: ComposedLayer[] = await Promise.all(
    relativePaths.map(async (relativePath) => {
      const filePath = `${homeRoot}/${relativePath}`
      if (!(await filesystem.exists(filePath))) {
        return { relativePath, contents: undefined }
      }
      return { relativePath, contents: (await filesystem.readFile(filePath)).trim() }
    }),
  )

  const headerLines = layers.map(
    (layer, index) => `${index + 1}. ${layer.relativePath} — ${layer.contents === undefined ? "skipped (missing)" : "included"}`,
  )
  const header = `<!-- FirstMate composed instructions. Do not edit by hand — edit the layer files and recompose.
Layers, lowest to highest precedence (a later layer outranks earlier ones; a project file adds to or overrides the shared file of its kind):
${headerLines.join("\n")}
-->`
  const body = layers
    .filter((layer) => layer.contents !== undefined)
    .map((layer) => `<!-- layer: ${layer.relativePath} -->\n\n${layer.contents}`)
    .join("\n\n")

  const settings = await loadProjectSettings(filesystem, `${homeRoot}/projects/${slug}`)
  const workerDefaults = [
    settings.workerModel === "" ? "" : `Use model ${JSON.stringify(settings.workerModel)} for new workers (session.create model; CLI --model), unless the captain explicitly chooses another.`,
    settings.workerVariant === "" ? "" : `Use variant ${JSON.stringify(settings.workerVariant)} for new workers (session.create variant; CLI --variant), unless the captain explicitly chooses another.`,
  ].filter(Boolean)
  const defaultsSection = workerDefaults.length === 0 ? "" : `\n\n## Configured worker defaults\n\n${workerDefaults.join("\n")}\n`
  const composed = `${header}\n\n${body}${defaultsSection}\n`
  const filePath = `${homeRoot}/projects/${slug}/AGENTS.md`
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  await filesystem.writeFile(temporaryPath, composed)
  await filesystem.rename(temporaryPath, filePath)
  return composed
}
