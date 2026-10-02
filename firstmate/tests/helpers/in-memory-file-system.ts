import type { FileSystemPort } from "../../service/file-system"

type FileSystemNode = { kind: "file"; contents: string } | { kind: "directory" }

export class InMemoryFileSystem {
  private readonly entries = new Map<string, FileSystemNode>()

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
  }

  seedFile(filePath: string, contents: string): void {
    this.entries.set(filePath, { kind: "file", contents })
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
}
