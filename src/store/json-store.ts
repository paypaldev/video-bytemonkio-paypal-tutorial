/**
 * A deliberately boring key/value store backed by one JSON file per table.
 *
 * Why a file and not a database: the interesting part of this repo is the
 * payment logic, and a reviewer should be able to `cat .data/events.json` to
 * see exactly what the application believed and when. In a real system these
 * tables are rows in Postgres with a UNIQUE constraint doing the deduplication
 * — the constraint is the point, not the storage engine. See docs/DECISIONS.md.
 *
 * Writes are atomic (write temp + rename) so a crash mid-write cannot leave a
 * half-written ledger behind, which would defeat the purpose of having one.
 */

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";

export class JsonStore<T> {
  private readonly file: string;
  private cache: Record<string, T> | null = null;

  constructor(name: string) {
    this.file = path.join(DATA_DIR, `${name}.json`);
  }

  private read(): Record<string, T> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, T>;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private write(data: Record<string, T>): void {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file);
    this.cache = data;
  }

  /** Always re-read from disk. The server and the scenarios are separate processes. */
  private fresh(): Record<string, T> {
    this.cache = null;
    return this.read();
  }

  get(key: string): T | undefined {
    return this.fresh()[key];
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  set(key: string, value: T): void {
    const data = this.fresh();
    data[key] = value;
    this.write(data);
  }

  entries(): Array<[string, T]> {
    return Object.entries(this.fresh());
  }

  values(): T[] {
    return Object.values(this.fresh());
  }

  clear(): void {
    this.write({});
  }
}
