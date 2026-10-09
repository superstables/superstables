import type { Server } from 'node:http';
import type { TestContext } from 'vitest';

export async function listenOrSkip(server: Server, context: TestContext): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      server.once('error', failed);
      server.listen(0, '127.0.0.1', () => { server.off('error', failed); resolve(); });
    });
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      context.skip(`sandbox blocks listening on 127.0.0.1 (${error.code}); this seller test requires local network access`);
    }
    throw error;
  }
}
