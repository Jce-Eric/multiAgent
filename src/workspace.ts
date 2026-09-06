import { promises as fs } from "node:fs";
import path from "node:path";
import { GatewayError } from "./errors.js";
import type { WorkspaceRef } from "./types.js";

export interface ResolvedWorkspace {
  directory: string;
  workspace: WorkspaceRef;
}

export class WorkspaceResolver {
  constructor(
    private readonly defaultDirectory = process.cwd(),
    private readonly allowedRoots: string[] = [],
  ) {}

  async resolve(directory?: string): Promise<ResolvedWorkspace> {
    const requested = path.resolve(directory ?? this.defaultDirectory);
    let resolved: string;
    try {
      resolved = await fs.realpath(requested);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new GatewayError(400, "DIRECTORY_NOT_FOUND", `Directory '${requested}' does not exist`);
      }
      throw error;
    }
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      throw new GatewayError(400, "DIRECTORY_INVALID", `Path '${resolved}' is not a directory`);
    }
    if (this.allowedRoots.length) {
      const roots = await Promise.all(this.allowedRoots.map((root) => fs.realpath(path.resolve(root))));
      if (!roots.some((root) => isWithin(root, resolved))) {
        throw new GatewayError(
          403,
          "DIRECTORY_NOT_ALLOWED",
          `Directory '${resolved}' is outside the configured allowed roots`,
        );
      }
    }
    return { directory: resolved, workspace: { type: "local", directory: resolved } };
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
