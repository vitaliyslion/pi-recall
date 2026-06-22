import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempDirs {
  cwd: string;
  agentDir: string;
  cleanup: () => Promise<void>;
}

export async function makeTempDirs(): Promise<TempDirs> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-recall-cwd-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-recall-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return {
    cwd,
    agentDir,
    cleanup: async () => {
      await rm(cwd, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    },
  };
}
