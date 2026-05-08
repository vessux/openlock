export async function completeCmd(args: string[]): Promise<number> {
  const shell = args[0];
  switch (shell) {
    case "bash": {
      const { completionScript } = await import("./completions/bash");
      process.stdout.write(completionScript());
      return 0;
    }
    case "zsh": {
      const { completionScript } = await import("./completions/zsh");
      process.stdout.write(completionScript());
      return 0;
    }
    case "fish": {
      const { completionScript } = await import("./completions/fish");
      process.stdout.write(completionScript());
      return 0;
    }
    default:
      console.error("Usage: openlock complete <bash|zsh|fish>");
      return 1;
  }
}
