import * as path from 'node:path';
import Mocha from 'mocha';
import { glob } from 'glob';

export async function run(): Promise<void> {
  const mocha = new Mocha({
    // TDD, matching how the suite declares itself (`suite`/`test`). With `bdd`
    // those globals do not exist and the file throws `suite is not defined`
    // while loading — before a single test runs, so the failure looks like a
    // harness crash rather than a mismatch.
    ui: 'tdd',
    color: true,
    // The baseline build, sweeps and editor round-trips are all real work.
    timeout: 60_000,
  });

  const testsRoot = __dirname;
  const files = await glob('**/*.test.js', { cwd: testsRoot });
  for (const file of files.sort()) {
    mocha.addFile(path.resolve(testsRoot, file));
  }

  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) reject(new Error(`${failures} test(s) failed.`));
        else resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}
