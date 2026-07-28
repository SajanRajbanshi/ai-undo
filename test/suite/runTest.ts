import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { runTests } from '@vscode/test-electron';

/**
 * §13.3 — launches a real extension host against a throwaway single-root
 * workspace. The fixture is generated here rather than committed so each run
 * starts from a known-clean tree with no stale checkpoint store.
 */
async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
  const extensionTestsPath = path.resolve(__dirname, './index');

  const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'lfct-host-'));
  const workspace = path.join(base, 'project');
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'src', 'app.ts'), 'export const app = 1;\n');
  await fs.writeFile(path.join(workspace, 'src', 'utils.ts'), 'export const util = 2;\n');
  await fs.writeFile(path.join(workspace, 'src', 'doomed.ts'), 'export const doomed = 3;\n');
  await fs.writeFile(path.join(workspace, '.gitignore'), '.env\nnode_modules/\n');
  await fs.writeFile(path.join(workspace, '.env'), 'SECRET=original\n');
  await fs.mkdir(path.join(workspace, 'node_modules', 'dep'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'node_modules', 'dep', 'index.js'), 'module.exports={};\n');

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspace,
        '--disable-extensions',
        '--disable-workspace-trust',
        `--user-data-dir=${path.join(base, 'user-data')}`,
      ],
      extensionTestsEnv: { LFCT_TEST_WORKSPACE: workspace },
    });
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Extension host tests failed:', err);
  process.exit(1);
});
