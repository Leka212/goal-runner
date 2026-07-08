import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function readJsonFile<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

export async function appendLine(file: string, line: string): Promise<void> {
  await ensureDir(path.dirname(file));
  await appendFile(file, `${line}\n`, "utf8");
}

export async function fileSha256(file: string): Promise<string> {
  const body = await readFile(file);
  return createHash("sha256").update(body).digest("hex");
}
