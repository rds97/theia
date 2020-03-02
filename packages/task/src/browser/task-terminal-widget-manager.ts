/********************************************************************************
 * Copyright (C) 2020 Ericsson and others.
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

import { inject, injectable, postConstruct } from 'inversify';
import { ApplicationShell, WidgetOpenerOptions } from '@theia/core/lib/browser';
import { TerminalWidget } from '@theia/terminal/lib/browser/base/terminal-widget';
import { TerminalWidgetFactoryOptions } from '@theia/terminal/lib/browser/terminal-widget-impl';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import { PanelKind, TaskConfiguration, TaskWatcher, TaskExitedEvent, TaskServer } from '../common';
import { TaskDefinitionRegistry } from './task-definition-registry';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';

export interface TaskTerminalWidgetOpenerOptions extends WidgetOpenerOptions, TerminalWidgetFactoryOptions {
    taskId: number;
    taskPanel?: PanelKind;
    taskConfig?: TaskConfiguration;
}
export namespace TaskTerminalWidgetOpenerOptions {
    export function isDedicatedTerminal(options: TaskTerminalWidgetOpenerOptions): boolean {
        return !!options.taskPanel && options.taskPanel === PanelKind.Dedicated;
    }

    export function isNewTerminal(options: TaskTerminalWidgetOpenerOptions): boolean {
        return !!options.taskPanel && options.taskPanel === PanelKind.New;
    }

    export function isSharedTerminal(options: TaskTerminalWidgetOpenerOptions): boolean {
        return options.taskPanel === undefined || options.taskPanel === PanelKind.Shared;
    }
}

@injectable()
export class TaskTerminalWidgetManager {

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(TaskDefinitionRegistry)
    protected readonly taskDefinitionRegistry: TaskDefinitionRegistry;

    @inject(TerminalService)
    protected readonly terminalService: TerminalService;

    @inject(TaskWatcher)
    protected readonly taskWatcher: TaskWatcher;

    @inject(TaskServer)
    protected readonly taskServer: TaskServer;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    // Map indexed by terminal widget id
    protected terminalWidgetMap: Map<string, { isDedicated: boolean, taskId: number, taskConfig?: TaskConfiguration, isIdle: boolean }> = new Map();

    @postConstruct()
    protected init(): void {
        this.taskWatcher.onTaskExit((event: TaskExitedEvent) => {
            const finishedTaskId = event.taskId;
            // find the terminal where the task ran, and mark it as "idle"
            for (const widgetId of this.terminalWidgetMap.keys()) {
                const entry = this.terminalWidgetMap.get(widgetId)!;
                if (entry.taskId === finishedTaskId) {
                    entry.isIdle = true;

                    const terminalWidget = this.terminalService.getById(widgetId);
                    if (terminalWidget) {
                        terminalWidget.scrollToBottom();
                        terminalWidget.writeLine('\x1b[1m\n\rTerminal will be reused by tasks. \x1b[0m\n');
                    }

                    break;
                }
            }
        });
        const context = this.workspaceService.workspace && this.workspaceService.workspace.uri;
        this.terminalService.onDidCreateTerminal((widget: TerminalWidget) => {
            const toDisposeCreateListener = widget.onDidReconnectTerminalProcess(async (widgetThatReconnects: TerminalWidget) => {
                const tasksInfo = await this.taskServer.getTasks(context);
                if (this.terminalWidgetMap.has(widgetThatReconnects.id)) { // the widget is already kept track of
                    return;
                }
                const taskInfo = tasksInfo.find(info => info.terminalId === widgetThatReconnects.terminalId);
                if (taskInfo) {
                    const taskConfig = taskInfo.config;
                    const isDedicated = !!taskConfig.presentation && !!taskConfig.presentation.panel && taskConfig.presentation.panel === PanelKind.Dedicated;
                    this.terminalWidgetMap.set(widgetThatReconnects.id, {
                        isDedicated, taskId: taskInfo.taskId, taskConfig, isIdle: false
                    });
                } else {
                    this.terminalWidgetMap.set(widgetThatReconnects.id, {
                        isDedicated: false, taskId: -1, isIdle: true
                    });
                }
                const toDisposeCloseEvent = widgetThatReconnects.onTerminalDidClose(() => {
                    if (this.terminalWidgetMap.has(widgetThatReconnects.id)) {
                        this.terminalWidgetMap.delete(widgetThatReconnects.id);
                    }
                    toDisposeCloseEvent.dispose();
                    toDisposeCreateListener.dispose();
                });
            });
        });
    }

    async open(options: TaskTerminalWidgetOpenerOptions): Promise<TerminalWidget> {
        const isDedicated = TaskTerminalWidgetOpenerOptions.isDedicatedTerminal(options);
        if (isDedicated && !options.taskConfig) {
            throw new Error('"taskConfig" must be included as part of the "option" if "isDedicated" is true');
        }

        const { isNew, widget } = await this.getWidgetToRunTask(options);
        if (isNew) {
            this.shell.addWidget(widget, { area: options.widgetOptions ? options.widgetOptions.area : 'bottom' });
            this.terminalWidgetMap.set(widget.id, {
                isDedicated,
                taskId: options.taskId,
                taskConfig: options.taskConfig,
                isIdle: false
            });
            widget.resetTerminal();
        } else if (options.title) {
            widget.setTitle(options.title);
            const entry = this.terminalWidgetMap.get(widget.id);
            if (entry) {
                entry.taskId = options.taskId;
                entry.isIdle = false;
            }
        }

        this.terminalService.open(widget, options);

        return widget;
    }

    protected async getWidgetToRunTask(options: TaskTerminalWidgetOpenerOptions): Promise<{ isNew: boolean, widget: TerminalWidget }> {
        let reusableTerminalWidget: TerminalWidget | undefined;
        if (TaskTerminalWidgetOpenerOptions.isDedicatedTerminal(options)) {
            for (const [widgetId, { isDedicated, taskConfig, isIdle }] of this.terminalWidgetMap.entries()) {
                const widget = this.terminalService.getById(widgetId);
                if (!widget) {
                    continue;
                }
                // to run a task whose `taskPresentation === 'dedicated'`, the terminal to be reused must be
                // 1) dedicated, 2) idle, and 3) the one that ran the same task
                if (isDedicated &&
                    isIdle &&
                    taskConfig &&
                    options.taskConfig &&
                    this.taskDefinitionRegistry.compareTasks(options.taskConfig, taskConfig)) {

                    reusableTerminalWidget = widget;
                    break;
                }
            }
        } else if (TaskTerminalWidgetOpenerOptions.isSharedTerminal(options)) {
            const availableWidgets: TerminalWidget[] = [];
            for (const [widgetId, { isDedicated, isIdle }] of this.terminalWidgetMap.entries()) {
                const widget = this.terminalService.getById(widgetId);
                if (!widget) {
                    continue;
                }
                // to run a task whose `taskPresentation === 'shared'`, the terminal to be used must be
                // 1) not dedicated, and 2) idle
                if (!isDedicated && isIdle) {
                    availableWidgets.push(widget);
                }
            }
            const lastUsedWidget = availableWidgets.find(w => {
                const lastUsedTerminal = this.terminalService.lastUsedTerminal;
                return lastUsedTerminal && lastUsedTerminal.id === w.id;
            });
            reusableTerminalWidget = lastUsedWidget || availableWidgets[0];
        }

        // we are unable to find a terminal widget to run the task, or `taskPresentation === 'new'`
        if (!reusableTerminalWidget) {
            const widget = await this.terminalService.newTerminal(options);
            const toDispose = widget.onTerminalDidClose(() => {
                if (this.terminalWidgetMap.has(widget.id)) {
                    this.terminalWidgetMap.delete(widget.id);
                }
                toDispose.dispose();
            });
            return { isNew: true, widget };
        }
        return { isNew: false, widget: reusableTerminalWidget };
    }
}
