import * as path from "node:path";

interface CapabilitySnapshotItem {
  kind: "extension" | "skill";
  path: string;
  enabled: boolean;
}

export interface LoadedCapabilityPaths {
  extensions: readonly string[];
  skills: readonly string[];
}

/** Session-owned cache whose reads never trigger capability discovery. */
export class SessionCapabilitySnapshot<T> {
  private items: T[] = [];

  constructor(private readonly scan: () => Promise<readonly T[]>) {}

  read(): T[] {
    return [...this.items];
  }

  async refresh(): Promise<T[]> {
    this.items = [...await this.scan()];
    return this.read();
  }
}

function capabilityPathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Keep disabled resources manageable, but only show enabled resources that
 * were actually loaded into this Session at the snapshot boundary.
 */
export function filterSessionCapabilitySnapshot<T extends CapabilitySnapshotItem>(
  capabilities: readonly T[],
  loaded: LoadedCapabilityPaths,
): T[] {
  const loadedByKind = {
    extension: new Set(loaded.extensions.map(capabilityPathKey)),
    skill: new Set(loaded.skills.map(capabilityPathKey)),
  };

  return capabilities.filter((capability) =>
    !capability.enabled
    || loadedByKind[capability.kind].has(capabilityPathKey(capability.path))
  );
}
