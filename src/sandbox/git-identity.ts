import { writeFileSync } from "fs";
import { join } from "path";

interface PrepareOpts {
  homeOverride?: string;
}

async function readGitConfig(key: string, homeOverride?: string): Promise<string | null> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (homeOverride) {
    env.HOME = homeOverride;
    env.GIT_CONFIG_GLOBAL = `${homeOverride}/.gitconfig`;
    delete env.XDG_CONFIG_HOME;
    delete env.GIT_CONFIG_SYSTEM;
  }
  const proc = Bun.spawn(["git", "config", "--global", "--get", key], {
    stdout: "pipe",
    stderr: "ignore",
    env,
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) return null;
  const trimmed = out.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function prepareGitIdentity(
  tmpDir: string,
  opts: PrepareOpts = {},
): Promise<string | null> {
  const [name, email] = await Promise.all([
    readGitConfig("user.name", opts.homeOverride),
    readGitConfig("user.email", opts.homeOverride),
  ]);
  if (name === null || email === null) return null;

  const gitconfigPath = join(tmpDir, ".gitconfig");
  const contents = `[user]\n\tname = ${name}\n\temail = ${email}\n`;
  writeFileSync(gitconfigPath, contents);
  return gitconfigPath;
}
