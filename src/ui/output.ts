import * as vscode from 'vscode';
import { EXTENSION_NAME } from '../constants';
import StatusBarItem from './statusBarItem';

let isShow = false;
const outputChannel = vscode.window.createOutputChannel(EXTENSION_NAME);
let statusBarUpdater: ((status: number) => void) | null = null;

export function registerStatusBarUpdater(
  updater: (status: number) => void
) {
  statusBarUpdater = updater;
}

export function show() {
  statusBarUpdater?.(StatusBarItem.Status.ok);
  outputChannel.show();
  isShow = true;
}

export function reveal(preserveFocus: boolean = false) {
  statusBarUpdater?.(StatusBarItem.Status.ok);
  outputChannel.show(preserveFocus);
  isShow = true;
}

export function hide() {
  outputChannel.hide();
  isShow = false;
}

export function toggle() {
  if (isShow) {
    hide();
  } else {
    show();
  }
}

export function print(...args) {
  const msg = args
    .map(arg => {
      if (!arg) {
        return arg;
      }

      if (arg instanceof Error) {
        return arg.stack;
      } else if (!arg.toString || arg.toString() === '[object Object]') {
        return JSON.stringify(arg);
      }

      return arg;
    })
    .join(' ');

  outputChannel.appendLine(msg);
}
