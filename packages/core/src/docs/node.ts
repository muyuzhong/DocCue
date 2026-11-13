/** Reading documentation from a folder (Node only). */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { createDocs, type DocFile, type DocsOptions, type DocsProvider } from './docs.js';

/** Every Markdown file under `dir` (`.md`, `.mdx`, `.markdown`), read once. */
export async function markdownDocs(dir: string, options: DocsOptions = {}): Promise<DocsProvider> {
  const files: DocFile[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(md|mdx|markdown)$/i.test(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    files.push({ path: relative(dir, path).split(sep).join('/'), content: await readFile(path, 'utf8') });
  }
  return createDocs(files, options);
}
