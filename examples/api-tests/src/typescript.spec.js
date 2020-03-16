/********************************************************************************
 * Copyright (C) 2020 TypeFox and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

// @ts-check
/// <reference types='@theia/monaco/src/typings/monaco'/>
describe('TypeScript', function () {
    this.timeout(15000);

    const { assert } = chai;

    const Uri = require('@theia/core/lib/common/uri');
    const { DisposableCollection } = require('@theia/core/lib/common/disposable');
    const { BrowserMainMenuFactory } = require('@theia/core/lib/browser/menu/browser-menu-plugin');
    const { EditorManager } = require('@theia/editor/lib/browser/editor-manager');
    const { EditorWidget } = require('@theia/editor/lib/browser/editor-widget');
    const { EDITOR_CONTEXT_MENU } = require('@theia/editor/lib/browser/editor-menu');
    const { WorkspaceService } = require('@theia/workspace/lib/browser/workspace-service');
    const { MonacoEditor } = require('@theia/monaco/lib/browser/monaco-editor');
    const { HostedPluginSupport } = require('@theia/plugin-ext/lib/hosted/browser/hosted-plugin');
    const { ContextKeyService } = require('@theia/core/lib/browser/context-key-service');
    const { CommandRegistry } = require('@theia/core/lib/common/command');
    const { KeybindingRegistry } = require('@theia/core/lib/browser/keybinding');
    const { OpenerService, open } = require('@theia/core/lib/browser/opener-service');
    const { EditorPreviewWidget } = require('@theia/editor-preview/lib/browser/editor-preview-widget');
    const { animationFrame } = require('@theia/core/lib/browser/browser');
    const { PreferenceService, PreferenceScope } = require('@theia/core/lib/browser/preferences/preference-service');

    /** @type {import('inversify').Container} */
    const container = window['theia'].container;
    const editorManager = container.get(EditorManager);
    const workspaceService = container.get(WorkspaceService);
    const menuFactory = container.get(BrowserMainMenuFactory);
    const pluginService = container.get(HostedPluginSupport);
    const contextKeyService = container.get(ContextKeyService);
    const commands = container.get(CommandRegistry);
    const openerService = container.get(OpenerService);
    const keybindings = container.get(KeybindingRegistry);
    /** @type {import('@theia/core/lib/browser/preferences/preference-service').PreferenceService} */
    const preferences = container.get(PreferenceService);

    const rootUri = new Uri.default(workspaceService.tryGetRoots()[0].uri);
    const serverUri = rootUri.resolve('src-gen/backend/server.js');
    const inversifyUri = rootUri.resolve('../../node_modules/inversify/dts/inversify.d.ts').normalizePath();
    const containerUri = rootUri.resolve('../../node_modules/inversify/dts/container/container.d.ts').normalizePath();

    before(async function () {
        await pluginService.load();
        const plugin = pluginService.plugins.find(p => p.model.id === 'vscode.typescript-language-features');
        await pluginService.activatePlugin(plugin.model.id);
    });

    beforeEach(async function () {
        await editorManager.closeAll({ save: false });
    });

    /**
     * @param {Uri.default} uri
     * @param {boolean} preview
     */
    async function openEditor(uri, preview = false) {
        const widget = await open(openerService, uri, { mode: 'activate', preview });
        const editorWidget = widget instanceof EditorPreviewWidget ? widget.editorWidget : widget instanceof EditorWidget ? widget : undefined;
        const editor = MonacoEditor.get(editorWidget);
        // wait till tsserver is running, see:
        // https://github.com/microsoft/vscode/blob/93cbbc5cae50e9f5f5046343c751b6d010468200/extensions/typescript-language-features/src/extension.ts#L98-L103
        await new Promise(resolve => {
            if (contextKeyService.match('typescript.isManagedFile')) {
                resolve();
                return;
            }
            contextKeyService.onDidChange(() => {
                if (contextKeyService.match('typescript.isManagedFile')) {
                    resolve();
                }
            });
        });
        return editor;
    }

    /**
     * @template T
     * @param {() => Promise<T> | T} condition
     * @returns {Promise<T>}
     */
    function waitForAnimation(condition) {
        return new Promise(async (resolve, dispose) => {
            toTearDown.push({ dispose });
            do {
                await animationFrame();
            } while (!condition());
            resolve();
        });
    }

    /**
     * @param {MonacoEditor} editor
     */
    async function assertPeekOpened(editor) {
        const referencesController = editor.getControl()._contributions['editor.contrib.referencesController'];
        await waitForAnimation(() => referencesController._widget && referencesController._widget._tree.getFocus().length);

        assert.isFalse(contextKeyService.match('editorTextFocus'));
        assert.isTrue(contextKeyService.match('referenceSearchVisible'));
        assert.isTrue(contextKeyService.match('listFocus'));
    }

    /**
     * @param {MonacoEditor} editor
     */
    async function openPeek(editor) {
        assert.isTrue(contextKeyService.match('editorTextFocus'));
        assert.isFalse(contextKeyService.match('referenceSearchVisible'));
        assert.isFalse(contextKeyService.match('listFocus'));

        await commands.executeCommand('editor.action.peekDefinition');
        await assertPeekOpened(editor);
    }

    async function openReference() {
        keybindings.dispatchKeyDown('Enter');
        await waitForAnimation(() => contextKeyService.match('listFocus'));
        assert.isFalse(contextKeyService.match('editorTextFocus'));
        assert.isTrue(contextKeyService.match('referenceSearchVisible'));
        assert.isTrue(contextKeyService.match('listFocus'));
    }

    async function closePeek() {
        keybindings.dispatchKeyDown('Escape');
        await waitForAnimation(() => !contextKeyService.match('listFocus'));
        assert.isTrue(contextKeyService.match('editorTextFocus'));
        assert.isFalse(contextKeyService.match('referenceSearchVisible'));
        assert.isFalse(contextKeyService.match('listFocus'));
    }

    afterEach(async () => {
        await editorManager.closeAll({ save: false });
    });

    const toTearDown = new DisposableCollection();
    afterEach(() => toTearDown.dispose());

    it('document formating should be visible and enabled', async () => {
        await openEditor(serverUri);
        const menu = menuFactory.createContextMenu(EDITOR_CONTEXT_MENU);
        const item = menu.items.find(i => i.command === 'editor.action.formatDocument');
        assert.isDefined(item);
        assert.isTrue(item.isVisible);
        assert.isTrue(item.isEnabled);
    });

    describe('editor.action.revealDefinition', function () {
        for (const preview of [false, true]) {
            const from = 'an editor' + (preview ? ' preview' : '');
            it('within ' + from, async function () {
                const editor = await openEditor(serverUri, preview);
                // con|tainer.load(backendApplicationModule);
                editor.getControl().setPosition({ lineNumber: 12, column: 4 });
                assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, 'container');

                await commands.executeCommand('editor.action.revealDefinition');

                const activeEditor = MonacoEditor.get(editorManager.activeEditor);
                assert.equal(editorManager.activeEditor.parent instanceof EditorPreviewWidget, preview);
                assert.equal(activeEditor.uri.toString(), serverUri.toString());
                // const |container = new Container();
                const { lineNumber, column } = activeEditor.getControl().getPosition();
                assert.deepEqual({ lineNumber, column }, { lineNumber: 11, column: 7 });
                assert.equal(activeEditor.getControl().getModel().getWordAtPosition({ lineNumber, column }).word, 'container');
            });

            it(`from ${from} to another editor`, async function () {
                await editorManager.open(inversifyUri, { mode: 'open' });

                const editor = await openEditor(serverUri, preview);
                // const { Cont|ainer } = require('inversify');
                editor.getControl().setPosition({ lineNumber: 5, column: 13 });
                assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, 'Container');

                await commands.executeCommand('editor.action.revealDefinition');

                const activeEditor = MonacoEditor.getActive(editorManager);
                assert.isFalse(editorManager.activeEditor.parent instanceof EditorPreviewWidget);
                assert.equal(activeEditor.uri.toString(), inversifyUri.toString());
                // export { |Container } from "./container/container";
                const { lineNumber, column } = activeEditor.getControl().getPosition();
                assert.deepEqual({ lineNumber, column }, { lineNumber: 3, column: 10 });
                assert.equal(activeEditor.getControl().getModel().getWordAtPosition({ lineNumber, column }).word, 'Container');
            });

            it(`from ${from} to an editor preview`, async function () {
                const editor = await openEditor(serverUri);
                // const { Cont|ainer } = require('inversify');
                editor.getControl().setPosition({ lineNumber: 5, column: 13 });
                assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, 'Container');

                await commands.executeCommand('editor.action.revealDefinition');

                const activeEditor = MonacoEditor.getActive(editorManager);
                assert.isTrue(editorManager.activeEditor.parent instanceof EditorPreviewWidget);
                assert.equal(activeEditor.uri.toString(), inversifyUri.toString());
                // export { |Container } from "./container/container";
                const { lineNumber, column } = activeEditor.getControl().getPosition();
                assert.deepEqual({ lineNumber, column }, { lineNumber: 3, column: 10 });
                assert.equal(activeEditor.getControl().getModel().getWordAtPosition({ lineNumber, column }).word, 'Container');
            });
        }
    });

    describe('editor.action.peekDefinition', function () {

        for (const preview of [false, true]) {
            const from = 'an editor' + (preview ? ' preview' : '');
            it('within ' + from, async function () {
                const editor = await openEditor(serverUri, preview);
                // con|tainer.load(backendApplicationModule);
                editor.getControl().setPosition({ lineNumber: 12, column: 4 });
                assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, 'container');

                await openPeek(editor);
                await openReference();

                const activeEditor = MonacoEditor.get(editorManager.activeEditor);
                assert.equal(editorManager.activeEditor.parent instanceof EditorPreviewWidget, preview);
                assert.equal(activeEditor.uri.toString(), serverUri.toString());
                // const |container = new Container();
                const { lineNumber, column } = activeEditor.getControl().getPosition();
                assert.deepEqual({ lineNumber, column }, { lineNumber: 11, column: 7 });
                assert.equal(activeEditor.getControl().getModel().getWordAtPosition({ lineNumber, column }).word, 'container');

                await closePeek();
            });

            it(`from ${from} to another editor`, async function () {
                await editorManager.open(inversifyUri, { mode: 'open' });

                const editor = await openEditor(serverUri, preview);
                // const { Cont|ainer } = require('inversify');
                editor.getControl().setPosition({ lineNumber: 5, column: 13 });
                assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, 'Container');

                await openPeek(editor);
                await openReference();

                const activeEditor = MonacoEditor.getActive(editorManager);
                assert.isFalse(editorManager.activeEditor.parent instanceof EditorPreviewWidget);
                assert.equal(activeEditor.uri.toString(), inversifyUri.toString());
                // export { |Container } from "./container/container";
                const { lineNumber, column } = activeEditor.getControl().getPosition();
                assert.deepEqual({ lineNumber, column }, { lineNumber: 3, column: 10 });
                assert.equal(activeEditor.getControl().getModel().getWordAtPosition({ lineNumber, column }).word, 'Container');

                await closePeek();
            });

            it(`from ${from} to an editor preview`, async function () {
                const editor = await openEditor(serverUri);
                // const { Cont|ainer } = require('inversify');
                editor.getControl().setPosition({ lineNumber: 5, column: 13 });
                assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, 'Container');

                await openPeek(editor);
                await openReference();

                const activeEditor = MonacoEditor.getActive(editorManager);
                assert.isTrue(editorManager.activeEditor.parent instanceof EditorPreviewWidget);
                assert.equal(activeEditor.uri.toString(), inversifyUri.toString());
                // export { |Container } from "./container/container";
                const { lineNumber, column } = activeEditor.getControl().getPosition();
                assert.deepEqual({ lineNumber, column }, { lineNumber: 3, column: 10 });
                assert.equal(activeEditor.getControl().getModel().getWordAtPosition({ lineNumber, column }).word, 'Container');

                await closePeek();
            });
        }
    });

    it('editor.action.triggerSuggest', async function () {
        const editor = await openEditor(serverUri);
        // const { [|Container] } = require('inversify');
        editor.getControl().setPosition({ lineNumber: 5, column: 9 });
        editor.getControl().setSelection({ startLineNumber: 5, startColumn: 9, endLineNumber: 5, endColumn: 18 });
        assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, 'Container');

        assert.isTrue(contextKeyService.match('editorTextFocus'));
        assert.isFalse(contextKeyService.match('suggestWidgetVisible'));

        await commands.executeCommand('editor.action.triggerSuggest');
        await waitForAnimation(() => contextKeyService.match('suggestWidgetVisible'));

        assert.isTrue(contextKeyService.match('editorTextFocus'));
        assert.isTrue(contextKeyService.match('suggestWidgetVisible'));

        keybindings.dispatchKeyDown('Enter');
        await waitForAnimation(() => !contextKeyService.match('suggestWidgetVisible'));

        assert.isTrue(contextKeyService.match('editorTextFocus'));
        assert.isFalse(contextKeyService.match('suggestWidgetVisible'));

        const activeEditor = MonacoEditor.getActive(editorManager);
        assert.equal(activeEditor.uri.toString(), serverUri.toString());
        // const { Container| } = require('inversify');
        const { lineNumber, column } = activeEditor.getControl().getPosition();
        assert.deepEqual({ lineNumber, column }, { lineNumber: 5, column: 18 });
        assert.equal(activeEditor.getControl().getModel().getWordAtPosition({ lineNumber, column }).word, 'Container');
    });

    it('editor.action.rename', async function () {
        const editor = await openEditor(serverUri);
        // const |container = new Container();
        editor.getControl().setPosition({ lineNumber: 11, column: 7 });
        assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, 'container');

        assert.isTrue(contextKeyService.match('editorTextFocus'));
        assert.isFalse(contextKeyService.match('renameInputVisible'));

        const renaming = commands.executeCommand('editor.action.rename');
        await waitForAnimation(() => contextKeyService.match('renameInputVisible')
            && document.activeElement instanceof HTMLInputElement
            && document.activeElement.selectionEnd === 'container'.length);
        assert.isFalse(contextKeyService.match('editorTextFocus'));
        assert.isTrue(contextKeyService.match('renameInputVisible'));

        const input = document.activeElement;
        if (!(input instanceof HTMLInputElement)) {
            assert.fail('expected focused input, but: ' + input);
            return;
        }

        input.value = 'foo';
        keybindings.dispatchKeyDown('Enter', input);

        await renaming;
        assert.isTrue(contextKeyService.match('editorTextFocus'));
        assert.isFalse(contextKeyService.match('renameInputVisible'));

        const activeEditor = MonacoEditor.getActive(editorManager);
        assert.equal(activeEditor.uri.toString(), serverUri.toString());
        // const |foo = new Container();
        const { lineNumber, column } = activeEditor.getControl().getPosition();
        assert.deepEqual({ lineNumber, column }, { lineNumber: 11, column: 7 });
        assert.equal(activeEditor.getControl().getModel().getWordAtPosition({ lineNumber, column }).word, 'foo');
    });

    it('editor.action.triggerParameterHints', async function () {
        const editor = await openEditor(serverUri);
        // container.load(|backendApplicationModule);
        editor.getControl().setPosition({ lineNumber: 12, column: 16 });
        assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, 'backendApplicationModule');

        assert.isTrue(contextKeyService.match('editorTextFocus'));
        assert.isFalse(contextKeyService.match('parameterHintsVisible'));

        await commands.executeCommand('editor.action.triggerParameterHints');
        await waitForAnimation(() => contextKeyService.match('parameterHintsVisible'));

        assert.isTrue(contextKeyService.match('editorTextFocus'));
        assert.isTrue(contextKeyService.match('parameterHintsVisible'));

        keybindings.dispatchKeyDown('Escape');
        await waitForAnimation(() => !contextKeyService.match('parameterHintsVisible'));

        assert.isTrue(contextKeyService.match('editorTextFocus'));
        assert.isFalse(contextKeyService.match('parameterHintsVisible'));
    });

    it('editor.action.showHover', async function () {
        const editor = await openEditor(serverUri);
        // container.load(|backendApplicationModule);
        editor.getControl().setPosition({ lineNumber: 12, column: 16 });
        assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, 'backendApplicationModule');

        const hover = editor.getControl()._contributions['editor.contrib.hover'];

        assert.isTrue(contextKeyService.match('editorTextFocus'));
        assert.isFalse(hover.contentWidget.isVisible);

        await commands.executeCommand('editor.action.showHover');
        await waitForAnimation(() => hover.contentWidget.isVisible);

        assert.isTrue(contextKeyService.match('editorTextFocus'));
        assert.isTrue(hover.contentWidget.isVisible);

        assert.equal(
            hover.contentWidget._domNode.innerHTML,
            // eslint-disable-next-line max-len
            '<div class="hover-row markdown-hover"><div class="hover-contents code-hover-contents"><div><div class="code" data-code="id#2" style="font-family: &quot;Droid Sans Mono&quot;, monospace, monospace, &quot;Droid Sans Fallback&quot;; font-weight: normal; font-size: 14px; font-feature-settings: &quot;liga&quot; 0, &quot;calt&quot; 0; line-height: 19px; letter-spacing: 0px;"><span style="font-family: \'Droid Sans Mono\', \'monospace\', monospace, \'Droid Sans Fallback\'"><div class="monaco-tokenized-source"><span class="mtk4">const</span><span class="mtk1"> </span><span class="mtk14">backendApplicationModule</span><span class="mtk1">: </span><span class="mtk10">ContainerModule</span></div></span></div></div></div></div>'
        );

        keybindings.dispatchKeyDown('Escape');
        await waitForAnimation(() => !hover.contentWidget.isVisible);

        assert.isTrue(contextKeyService.match('editorTextFocus'));
        assert.isFalse(hover.contentWidget.isVisible);
    });

    it('highligh semantic (write) occurences', async function () {
        const editor = await openEditor(serverUri);
        // const |container = new Container();
        const lineNumber = 11;
        const column = 7;
        const endColumn = column + 'container'.length;

        const hasWriteDecoration = () => {
            for (const decoration of editor.getControl().getModel().getLineDecorations(lineNumber)) {
                if (decoration.range.startColumn === column && decoration.range.endColumn === endColumn && decoration.options.className === 'wordHighlightStrong') {
                    return true;
                }
            }
            return false;
        };
        assert.isFalse(hasWriteDecoration());

        editor.getControl().setPosition({ lineNumber, column });
        assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, 'container');
        // highlight occurences is not trigged on the explicit position change, so move a cursor as a user
        keybindings.dispatchKeyDown('ArrowRight');
        await waitForAnimation(() => hasWriteDecoration());

        assert.isTrue(hasWriteDecoration());
    });

    it('editor.action.goToImplementation', async function () {
        const editor = await openEditor(serverUri);
        // con|tainer.load(backendApplicationModule);
        editor.getControl().setPosition({ lineNumber: 12, column: 4 });
        assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, 'container');

        await commands.executeCommand('editor.action.goToImplementation');

        const activeEditor = MonacoEditor.get(editorManager.activeEditor);
        assert.equal(activeEditor.uri.toString(), serverUri.toString());
        // const |container = new Container();
        const { lineNumber, column } = activeEditor.getControl().getPosition();
        assert.deepEqual({ lineNumber, column }, { lineNumber: 11, column: 7 });
        assert.equal(activeEditor.getControl().getModel().getWordAtPosition({ lineNumber, column }).word, 'container');
    });

    it('editor.action.goToTypeDefinition', async function () {
        const editor = await openEditor(serverUri);
        // con|tainer.load(backendApplicationModule);
        editor.getControl().setPosition({ lineNumber: 12, column: 4 });
        assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, 'container');

        await commands.executeCommand('editor.action.goToTypeDefinition');

        const activeEditor = MonacoEditor.get(editorManager.activeEditor);
        assert.equal(activeEditor.uri.toString(), containerUri.toString());
        // declare class |Container implements interfaces.Container {
        const { lineNumber, column } = activeEditor.getControl().getPosition();
        assert.deepEqual({ lineNumber, column }, { lineNumber: 2, column: 15 });
        assert.equal(activeEditor.getControl().getModel().getWordAtPosition({ lineNumber, column }).word, 'Container');
    });

    it('run reference code lens', async function () {
        this.timeout(30000);

        const globalValue = preferences.inspect('javascript.referencesCodeLens.enabled').globalValue;
        toTearDown.push({ dispose: () => preferences.set('javascript.referencesCodeLens.enabled', globalValue, PreferenceScope.User) });

        const editor = await openEditor(serverUri);

        const codeLens = editor.getControl()._contributions['css.editor.codeLens'];
        const codeLensNode = () => codeLens._lenses[0] && codeLens._lenses[0]._contentWidget && codeLens._lenses[0]._contentWidget._domNode;

        assert.isFalse(document.contains(codeLensNode()));

        // [export ]function load(raw) {
        editor.getControl().getModel().applyEdits([{
            range: monaco.Range.fromPositions({ lineNumber: 16, column: 1 }, { lineNumber: 16, column: 1 }),
            forceMoveMarkers: false,
            text: 'export '
        }]);
        await preferences.set('javascript.referencesCodeLens.enabled', true, PreferenceScope.User);
        await waitForAnimation(() => document.contains(codeLensNode()));

        const node = codeLensNode();
        assert.isTrue(document.contains(node));
        assert.equal(node.innerHTML, '<a id="0">19 references</a>');

        const link = node.getElementsByTagName('a').item(0);
        link.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        await assertPeekOpened(editor);
        await closePeek();
    });

});
