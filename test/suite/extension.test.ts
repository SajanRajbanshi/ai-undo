import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

import type { LfctApi } from '../../src/extension';

/**
 * §13.3 — extension-host tests. These are the only tests that can exercise the
 * SCM surface, the virtual document providers and the dirty-buffer path, all of
 * which need a real VS Code.
 */

const EXTENSION_ID = 'sajan.local-file-change-tracker';

let api: LfctApi;
let workspaceRoot: string;

function abs(rel: string): string {
  return path.join(workspaceRoot, ...rel.split('/'));
}

async function write(rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs(rel)), { recursive: true });
  await fs.writeFile(abs(rel), content);
}

async function exists(rel: string): Promise<boolean> {
  try {
    await fs.access(abs(rel));
    return true;
  } catch {
    return false;
  }
}

/** Resource descriptor accepted by every lfct command. */
function target(relPath: string, status: 'M' | 'A' | 'D') {
  return { relPath, status };
}

function pendingMap(): Record<string, string> {
  return Object.fromEntries(api.pending().map((s) => [s.relPath, s.status]));
}

suite('Local File Change Tracker', () => {
  suiteSetup(async function () {
    this.timeout(120_000);
    const extension = vscode.extensions.getExtension<LfctApi>(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} not found`);

    const exported = await extension.activate();
    assert.ok(exported, 'activate() returned no API — activation bailed out');
    api = exported;

    const ready = await api.whenReady();
    assert.equal(ready, true, 'baseline was never built');

    workspaceRoot = vscode.workspace.workspaceFolders![0].uri.fsPath;
    await api.refresh();
  });

  suite('activation', () => {
    test('activates on a single-root workspace', () => {
      assert.equal(vscode.workspace.workspaceFolders?.length, 1);
    });

    test('registers every contributed command (§4.4)', async () => {
      const all = await vscode.commands.getCommands(true);
      for (const id of [
        'lfct.acceptFile',
        'lfct.rejectFile',
        'lfct.acceptAll',
        'lfct.rejectAll',
        'lfct.openDiff',
        'lfct.openDiffSideBySide',
        'lfct.toggleDiffView',
        'lfct.refresh',
        'lfct.revealStorage',
        'lfct.listStores',
        'lfct.rebuildBaseline',
      ]) {
        assert.ok(all.includes(id), `${id} is not registered`);
      }
    });

    test('the baseline starts clean and stores outside the workspace (§5.3)', () => {
      assert.deepEqual(api.pending(), []);
      assert.ok(
        !api.storagePath().startsWith(workspaceRoot),
        'checkpoint storage must not live inside the project',
      );
    });
  });

  suite('detection and the SCM surface (§7.4)', () => {
    test('an external write surfaces as M', async () => {
      await write('src/app.ts', 'export const app = 999; // agent\n');
      await api.refresh();
      assert.equal(pendingMap()['src/app.ts'], 'M');
    });

    test('a created file surfaces as A and a deleted one as D', async () => {
      await write('src/generated.ts', 'export const gen = 1;\n');
      await fs.rm(abs('src/doomed.ts'));
      await api.refresh();

      const pending = pendingMap();
      assert.equal(pending['src/generated.ts'], 'A');
      assert.equal(pending['src/doomed.ts'], 'D');
    });

    test('a gitignored file is tracked (G6, S8)', async () => {
      await write('.env', 'SECRET=rewritten\n');
      await api.refresh();
      assert.equal(pendingMap()['.env'], 'M');
    });

    test('node_modules never appears', async () => {
      await write('node_modules/dep/index.js', 'module.exports={changed:true};\n');
      await api.refresh();
      assert.ok(!Object.keys(pendingMap()).some((p) => p.startsWith('node_modules/')));
    });
  });

  suite('inline unified diff (§7.5.1, G9)', () => {
    test('opens a one-column patch for a modified file', async () => {
      await vscode.commands.executeCommand('lfct.openDiff', target('src/app.ts', 'M'));
      const editor = vscode.window.activeTextEditor;
      assert.ok(editor, 'no editor opened');
      assert.equal(editor.document.uri.scheme, 'lfct-patch');
      assert.equal(editor.document.languageId, 'diff');

      const text = editor.document.getText();
      assert.ok(text.includes('+export const app = 999;'), `patch was:\n${text}`);
      assert.ok(text.includes('-export const app = 1;'), `patch was:\n${text}`);
    });

    test('renders an added file as all additions', async () => {
      await vscode.commands.executeCommand('lfct.openDiff', target('src/generated.ts', 'A'));
      const text = vscode.window.activeTextEditor!.document.getText();
      assert.ok(text.includes('new file mode'), text);
      assert.ok(text.includes('+export const gen = 1;'), text);
    });

    test('renders a deleted file as all deletions', async () => {
      await vscode.commands.executeCommand('lfct.openDiff', target('src/doomed.ts', 'D'));
      const text = vscode.window.activeTextEditor!.document.getText();
      assert.ok(text.includes('-export const doomed = 3;'), text);
    });

    test('the baseline provider serves prior content, and empty for a new file', async () => {
      const baseline = await vscode.workspace.openTextDocument(
        vscode.Uri.from({ scheme: 'lfct', path: '/src/app.ts', query: 'ref=HEAD' }),
      );
      assert.equal(baseline.getText(), 'export const app = 1;\n');

      const added = await vscode.workspace.openTextDocument(
        vscode.Uri.from({ scheme: 'lfct', path: '/src/generated.ts', query: 'ref=HEAD' }),
      );
      assert.equal(added.getText(), '');
    });

    test('side by side opens the native two-pane editor', async () => {
      await vscode.commands.executeCommand(
        'lfct.openDiffSideBySide',
        target('src/app.ts', 'M'),
      );
      assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof
        vscode.TabInputTextDiff, true);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });
  });

  suite('Accept (§8.3)', () => {
    test('advances the baseline without touching disk', async () => {
      const before = await fs.readFile(abs('.env'), 'utf8');
      await vscode.commands.executeCommand('lfct.acceptFile', target('.env', 'M'));
      const after = await fs.readFile(abs('.env'), 'utf8');

      assert.equal(after, before, 'Accept must never write to disk');
      assert.ok(!('.env' in pendingMap()), '.env should have left the pending list');
    });

    test('the patch view refreshes rather than going stale', async () => {
      await write('src/utils.ts', 'export const util = 42;\n');
      await api.refresh();

      await vscode.commands.executeCommand('lfct.openDiff', target('src/utils.ts', 'M'));
      const doc = vscode.window.activeTextEditor!.document;
      assert.ok(doc.getText().includes('+export const util = 42;'));

      await vscode.commands.executeCommand('lfct.acceptFile', target('src/utils.ts', 'M'));
      // Give the content provider's onDidChange time to propagate.
      await new Promise((r) => setTimeout(r, 500));

      const refreshed = await vscode.workspace.openTextDocument(doc.uri);
      assert.ok(
        !refreshed.getText().includes('+export const util = 42;'),
        `patch view went stale:\n${refreshed.getText()}`,
      );
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });
  });

  suite('Reject (§8.4)', () => {
    setup(async () => {
      await vscode.workspace.getConfiguration('lfct').update('confirmReject', 'never', true);
    });

    teardown(async () => {
      await vscode.workspace
        .getConfiguration('lfct')
        .update('confirmReject', undefined, true);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('restores a modified file from the baseline', async () => {
      await write('src/app.ts', 'totally rewritten by an agent\n');
      await api.refresh();
      assert.equal(pendingMap()['src/app.ts'], 'M');

      await vscode.commands.executeCommand('lfct.rejectFile', target('src/app.ts', 'M'));

      assert.equal(await fs.readFile(abs('src/app.ts'), 'utf8'), 'export const app = 1;\n');
      assert.ok(!('src/app.ts' in pendingMap()));
    });

    test('deletes an added file and prunes the directory it emptied (S6, E10d)', async () => {
      await write('src/scratch/deep/new.ts', 'export const n = 1;\n');
      await api.refresh();
      assert.equal(pendingMap()['src/scratch/deep/new.ts'], 'A');

      await vscode.commands.executeCommand(
        'lfct.rejectFile',
        target('src/scratch/deep/new.ts', 'A'),
      );

      assert.equal(await exists('src/scratch/deep/new.ts'), false);
      assert.equal(await exists('src/scratch'), false, 'empty husk left behind');
    });

    test('recreates a deleted file with exact baseline bytes (S7)', async () => {
      await vscode.commands.executeCommand('lfct.rejectFile', target('src/doomed.ts', 'D'));
      assert.equal(
        await fs.readFile(abs('src/doomed.ts'), 'utf8'),
        'export const doomed = 3;\n',
      );
    });

    test('does not re-list the file it just restored (E2, §6.6)', async () => {
      // Without pre-armed suppression our own restore write trips the watcher
      // and the file reappears immediately.
      await write('src/app.ts', 'agent again\n');
      await api.refresh();
      await vscode.commands.executeCommand('lfct.rejectFile', target('src/app.ts', 'M'));

      // Wait past the burst quiet window so any self-triggered burst would have
      // settled by now.
      await new Promise((r) => setTimeout(r, 2000));
      await api.refresh();
      assert.ok(!('src/app.ts' in pendingMap()), 'restored file was re-listed');
    });

    test('discards a dirty buffer and it does not resurrect on save (E1, S11)', async () => {
      const uri = vscode.Uri.file(abs('src/app.ts'));
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);

      // The user types without saving.
      await editor.edit((b) => b.insert(new vscode.Position(0, 0), '// unsaved user work\n'));
      assert.equal(doc.isDirty, true);

      // Meanwhile an agent rewrites the same file on disk.
      await write('src/app.ts', 'agent rewrote this\n');
      await api.refresh();
      assert.equal(pendingMap()['src/app.ts'], 'M');

      await vscode.commands.executeCommand('lfct.rejectFile', target('src/app.ts', 'M'));
      await new Promise((r) => setTimeout(r, 500));

      assert.equal(doc.isDirty, false, 'buffer should be clean after a forced revert');
      assert.equal(doc.getText(), 'export const app = 1;\n');

      // The critical part: saving must not push the stale buffer back to disk.
      await doc.save();
      assert.equal(await fs.readFile(abs('src/app.ts'), 'utf8'), 'export const app = 1;\n');
    });
  });

  suite('user edits advance the baseline silently (S5, §6.4)', () => {
    test('a save through the editor never enters the pending list', async () => {
      const uri = vscode.Uri.file(abs('src/utils.ts'));
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);

      await editor.edit((b) =>
        b.insert(new vscode.Position(0, 0), '// written by the user\n'),
      );
      await doc.save();

      // Past the user-edit debounce and the burst window.
      await new Promise((r) => setTimeout(r, 2500));
      await api.refresh();

      assert.ok(
        !('src/utils.ts' in pendingMap()),
        'a user edit must advance the baseline without surfacing',
      );
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });
  });

  suite('bulk operations', () => {
    test('Accept All empties the list without touching disk', async () => {
      await write('src/app.ts', 'bulk change 1\n');
      await write('src/utils.ts', 'bulk change 2\n');
      await write('src/fresh.ts', 'bulk change 3\n');
      await api.refresh();
      assert.ok(api.pending().length >= 3);

      const snapshot = await Promise.all(
        ['src/app.ts', 'src/utils.ts', 'src/fresh.ts'].map((p) =>
          fs.readFile(abs(p), 'utf8'),
        ),
      );

      await vscode.commands.executeCommand('lfct.acceptAll');

      assert.deepEqual(api.pending(), []);
      const after = await Promise.all(
        ['src/app.ts', 'src/utils.ts', 'src/fresh.ts'].map((p) =>
          fs.readFile(abs(p), 'utf8'),
        ),
      );
      assert.deepEqual(after, snapshot);
    });
  });

  suite('quick diff (§7.5.1 surface 2)', () => {
    test('a tracked file resolves to its baseline as the original resource', async () => {
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.from({ scheme: 'lfct', path: '/src/app.ts', query: 'ref=HEAD' }),
      );
      // The gutter bars themselves are drawn by VS Code; what we own is that the
      // baseline document resolves and carries the accepted content.
      assert.equal(doc.getText(), 'bulk change 1\n');
    });
  });
});
