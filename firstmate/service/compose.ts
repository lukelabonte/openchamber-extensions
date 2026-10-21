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
  const sessionTitles = [
    "## Session titles",
    "Create every new session with title `⚓ <task title>`, including scouts, implementation workers, landing workers, and relaunch replacements. This prefix takes precedence over older title conventions in the layers above. Keep existing session titles unchanged when adopting, resuming, or steering them.",
  ].join("\n\n")
  const workerSelection = [
    "## Worker model selection",
    "Before creating, resuming, steering, or relaunching a worker, select a model and supported effort variant for the next work. Pass both `model` and `variant` explicitly with the openchamber tool's `session.create` and `session.send` actions. Blank settings require a choice, not host defaults.",
    settings.workerModel === "" ? "" : `Use model ${JSON.stringify(settings.workerModel)} for new and resumed workers unless the captain explicitly chooses another.`,
    settings.workerVariant === "" ? "" : `Use variant ${JSON.stringify(settings.workerVariant)} for new and resumed workers unless the captain explicitly chooses another.`,
    "Choose each unset field yourself. Keep captain-set fields fixed unless the captain explicitly changes them. Use `models.search` with the worker's directory to check available models, costs, and each model's `variants` list; follow pagination or narrow the search as needed. `models.list` supplies favorites and recent selections, not variant support. Use the provider's exact variant id, not a fixed reasoning-level enum. Verify that the chosen model supports the variant, including when only one field is set by the captain. A model with no listed variants can't satisfy explicit effort selection; report that limit rather than inventing a variant.",
    "Reassess the next work rather than inheriting the session's previous selection. Choose the least costly model and effort that can reliably complete it. Move to a more capable model or higher effort for difficult reasoning, uncertain failures, or high-risk changes. Move to a smaller model or lower effort for bounded, routine work when the evidence supports it. Change only fields the captain left unset, at the next authorized send to an idle worker; preserve its session, worktree, history, scope, and holds. A model change isn't permission to interrupt, resume, or expand work.",
    "Record the selected model, exact variant, and short reason in the brief before dispatch and in the task's report before a resumed send. If the host rejects the selection, record the failure rather than claiming the change took effect. If no supported explicit pair satisfies the captain's choices, or model/variant support can't be verified, report the limit and stop before dispatch or resume. Never retry by dropping `model` or `variant` or silently changing a captain-set field.",
  ].filter(Boolean).join("\n\n")
  const composed = `${header}\n\n${body}\n\n${sessionTitles}\n\n${workerSelection}\n`
  const filePath = `${homeRoot}/projects/${slug}/AGENTS.md`
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  await filesystem.writeFile(temporaryPath, composed)
  await filesystem.rename(temporaryPath, filePath)
  return composed
}
