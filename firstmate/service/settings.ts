import type { FileSystemPort } from "./file-system"

export interface FirstmateSettings {
  coordinatorModel: string
  coordinatorVariant: string
  workerModel: string
  workerVariant: string
  refreshSeconds: number
}

export const defaultSettings: FirstmateSettings = {
  coordinatorModel: "", coordinatorVariant: "", workerModel: "", workerVariant: "", refreshSeconds: 30,
}

const settingNames = new Set(Object.keys(defaultSettings))

function validateSetting(name: string, value: unknown): void {
  if (!settingNames.has(name)) throw new Error(`unknown FirstMate setting: ${name}`)
  if (name === "refreshSeconds") {
    if (!Number.isInteger(value) || Number(value) < 5 || Number(value) > 3600) throw new Error("refreshSeconds must be an integer between 5 and 3600")
    return
  }
  if (typeof value !== "string") throw new Error(`${name} must be a string`)
  if (value === "") return
  if (name.endsWith("Model")) {
    if (value.length > 200 || !/^[A-Za-z0-9_.-]+\/[^\s]+$/.test(value)) throw new Error(`${name} must be a provider/model id`)
  } else if (value.length > 200 || value.trim() === "" || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error(`${name} must be a model variant id`)
  }
}

async function readSettingsRecord(filesystem: FileSystemPort, homeDirectory: string): Promise<Record<string, unknown>> {
  const filePath = `${homeDirectory}/settings.json`
  if (!(await filesystem.exists(filePath))) return {}
  const record: unknown = JSON.parse(await filesystem.readFile(filePath))
  if (record === null || typeof record !== "object" || Array.isArray(record)) throw new Error("FirstMate settings must be a JSON object")
  return record as Record<string, unknown>
}

export async function loadProjectSettings(filesystem: FileSystemPort, homeDirectory: string): Promise<FirstmateSettings> {
  const record = await readSettingsRecord(filesystem, homeDirectory)
  const settings = { ...defaultSettings }
  for (const name of settingNames) {
    if (record[name] === undefined) continue
    validateSetting(name, record[name])
    Object.assign(settings, { [name]: record[name] })
  }
  return settings
}

let settingsWriteSequence = 0
export async function saveProjectSettings(filesystem: FileSystemPort, homeDirectory: string, value: unknown): Promise<FirstmateSettings> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("settings must be a JSON object")
  for (const [name, setting] of Object.entries(value)) validateSetting(name, setting)
  const existing = await readSettingsRecord(filesystem, homeDirectory)
  const updated = { ...existing, ...value }
  const filePath = `${homeDirectory}/settings.json`
  const temporaryPath = `${filePath}.${Date.now()}.${++settingsWriteSequence}.tmp`
  await filesystem.writeFile(temporaryPath, `${JSON.stringify(updated, null, 2)}\n`)
  await filesystem.rename(temporaryPath, filePath)
  return loadProjectSettings(filesystem, homeDirectory)
}
