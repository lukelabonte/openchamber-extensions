import type { FileSystemPort } from "../../service/file-system"

type FileSystemNode = { kind: "file"; contents: string } | { kind: "directory" }

export class InMemoryFileSystem {
  private readonly entries = new Map<string, FileSystemNode>()
  private readonly executablePaths = new Set<string>()
  readonly renames: { fromPath: string; toPath: string }[] = []

  /** The from-path of the last rename that landed on toPath. */
  renamedFrom(toPath: string): string | undefined {
    for (let index = this.renames.length - 1; index >= 0; index -= 1) {
      if (this.renames[index].toPath === toPath) return this.renames[index].fromPath
    }
    return undefined
  }

  readonly port: FileSystemPort = {
    exists: async (filePath) => this.entries.has(filePath),
    readFile: async (filePath) => {
      const node = this.entries.get(filePath)
      if (node === undefined || node.kind !== "file") {
        throw new Error(`file not found: ${filePath}`)
      }
      return node.contents
    },
    writeFile: async (filePath, contents) => {
      this.entries.set(filePath, { kind: "file", contents })
    },
    appendFile: async (filePath, contents) => {
      const node = this.entries.get(filePath)
      const current = node !== undefined && node.kind === "file" ? node.contents : ""
      this.entries.set(filePath, { kind: "file", contents: current + contents })
    },
    createDirectory: async (directoryPath) => {
      this.entries.set(directoryPath, { kind: "directory" })
    },
    rename: async (fromPath, toPath) => {
      const node = this.entries.get(fromPath)
      if (node === undefined) {
        throw new Error(`file not found: ${fromPath}`)
      }
      this.entries.delete(fromPath)
      this.entries.set(toPath, node)
      this.renames.push({ fromPath, toPath })
    },
    listDirectories: async (directoryPath) => {
      const prefix = `${directoryPath}/`
      const names: string[] = []
      for (const [entryPath, node] of this.entries) {
        if (node.kind !== "directory" || !entryPath.startsWith(prefix)) continue
        const relativePath = entryPath.slice(prefix.length)
        if (relativePath.includes("/")) continue
        names.push(relativePath)
      }
      return names
    },
    listExecutableFiles: async (directoryPath) => {
      const prefix = `${directoryPath}/`
      const names: string[] = []
      for (const [entryPath, node] of this.entries) {
        if (node.kind !== "file" || !entryPath.startsWith(prefix)) continue
        const relativePath = entryPath.slice(prefix.length)
        if (relativePath.includes("/") || !this.executablePaths.has(entryPath)) continue
        names.push(relativePath)
      }
      return names
    },
    setExecutable: async (filePath) => {
      this.executablePaths.add(filePath)
    },
  }

  seedFile(filePath: string, contents: string): void {
    this.entries.set(filePath, { kind: "file", contents })
  }

  /** Seeds a file and marks it executable, like a chmod +x on disk. */
  seedExecutableFile(filePath: string, contents: string): void {
    this.seedFile(filePath, contents)
    this.executablePaths.add(filePath)
  }

  seedDirectory(directoryPath: string): void {
    this.entries.set(directoryPath, { kind: "directory" })
  }

  fileContents(filePath: string): string {
    const node = this.entries.get(filePath)
    if (node === undefined || node.kind !== "file") {
      throw new Error(`file not found: ${filePath}`)
    }
    return node.contents
  }

  directoryExists(directoryPath: string): boolean {
    const node = this.entries.get(directoryPath)
    return node !== undefined && node.kind === "directory"
  }

  fileIsExecutable(filePath: string): boolean {
    return this.executablePaths.has(filePath)
  }
}
