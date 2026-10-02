import type { FileSystemPort } from "./file-system"

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

  const composed = `${header}\n\n${body}\n`
  await filesystem.writeFile(`${homeRoot}/projects/${slug}/AGENTS.md`, composed)
  return composed
}
