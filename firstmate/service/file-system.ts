export interface FileSystemPort {
  exists(filePath: string): Promise<boolean>
  readFile(filePath: string): Promise<string>
  writeFile(filePath: string, contents: string): Promise<void>
  appendFile(filePath: string, contents: string): Promise<void>
  createDirectory(directoryPath: string): Promise<void>
  listDirectories(directoryPath: string): Promise<string[]>
  rename(fromPath: string, toPath: string): Promise<void>
}
