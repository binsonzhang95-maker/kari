export function droppedFilePath(file: unknown, resolvePath?: (file: File) => string): string;
export function droppedFilePaths(files: ArrayLike<File> | Iterable<File> | null | undefined, resolvePath?: (file: File) => string): string[];
