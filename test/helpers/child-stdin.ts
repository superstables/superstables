import type { ChildProcess } from "node:child_process";

/**
 * Types `text` into a child's stdin and closes it. A child that exits before it reads its input (it refused at once, or it
 * never asks) closes the pipe, and the write then fails with EPIPE; that says nothing about the test, which checks the child's
 * output and exit. Any other error on the pipe still fails the run.
 */
export function endStdin(child: ChildProcess, text = ""): void {
  child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
  child.stdin?.end(text);
}
