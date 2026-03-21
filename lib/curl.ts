import { spawn } from "node:child_process";

function getCurlCommand(): string {
  return process.platform === "win32" ? "curl.exe" : "curl";
}

export async function spawnCurl(args: string[], stdin?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(getCurlCommand(), args);
    const stdoutChunks: Buffer[] = [];
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `curl exited with code ${code}`));
        return;
      }
      resolve(Buffer.concat(stdoutChunks));
    });

    if (stdin) {
      child.stdin.write(stdin, "utf8");
    }
    child.stdin.end();
  });
}

export async function spawnCurlText(args: string[], stdin?: string): Promise<string> {
  const stdout = await spawnCurl(args, stdin);
  return stdout.toString("utf8");
}
