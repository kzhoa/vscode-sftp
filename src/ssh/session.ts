import * as vscode from 'vscode';
import app from '../app';
import { showErrorMessage } from '../host';
import logger from '../logger';
import * as output from '../ui/output';
import StatusBarItem from '../ui/statusBarItem';
import { detectFailureHint } from './failureClassifier';
import { RenderedSshCommand, SshLaunchPlan } from './launchPlan';

interface SessionResult {
  result: 'failed' | 'established' | 'completed';
  exitCode?: number;
}

function logEvent(event: string, payload: Record<string, unknown>) {
  logger.info(event, payload);
}

function waitForShellIntegration(terminal: vscode.Terminal, timeoutMs: number) {
  return new Promise<vscode.TerminalShellIntegration>((resolve, reject) => {
    if (terminal.shellIntegration) {
      resolve(terminal.shellIntegration);
      return;
    }

    const timeout = setTimeout(() => {
      dispose();
      reject(new Error('Terminal shell integration did not become available in time.'));
    }, timeoutMs);

    const integrationDisposable = vscode.window.onDidChangeTerminalShellIntegration(event => {
      if (event.terminal === terminal) {
        clearTimeout(timeout);
        dispose();
        resolve(event.shellIntegration);
      }
    });
    const closeDisposable = vscode.window.onDidCloseTerminal(closedTerminal => {
      if (closedTerminal === terminal) {
        clearTimeout(timeout);
        dispose();
        reject(new Error('Terminal closed before shell integration became available.'));
      }
    });

    function dispose() {
      integrationDisposable.dispose();
      closeDisposable.dispose();
    }
  });
}

function waitForExecutionEnd(
  terminal: vscode.Terminal,
  execution: vscode.TerminalShellExecution
) {
  return new Promise<vscode.TerminalShellExecutionEndEvent>(resolve => {
    const disposable = vscode.window.onDidEndTerminalShellExecution(event => {
      if (event.terminal === terminal && event.execution === execution) {
        disposable.dispose();
        resolve(event);
      }
    });
  });
}

async function collectExecutionOutput(execution: vscode.TerminalShellExecution) {
  let outputText = '';
  try {
    for await (const chunk of execution.read()) {
      outputText += chunk;
      if (outputText.length > 6000) {
        outputText = outputText.slice(-6000);
      }
    }
  } catch (_error) {
    return outputText;
  }

  return outputText;
}

function notifyFailure(message: string) {
  showErrorMessage(message, 'Details').then(result => {
    if (result === 'Details') {
      output.reveal(true);
    }
  });
}

export async function openSshTerminalSession(
  plan: SshLaunchPlan,
  command: RenderedSshCommand
): Promise<SessionResult> {
  if (plan.issues.some(issue => issue.code === 'hop-advanced-auth-not-rendered')) {
    throw new Error(plan.issues.find(issue => issue.code === 'hop-advanced-auth-not-rendered')!.message);
  }

  const activity = app.sftpBarItem.createActivity(`ssh-session:${plan.sessionId}`, {
    priority: 120,
    text: `SSH ${plan.profileName}: connecting`,
    tooltip: command.logText,
    spinning: true,
    status: StatusBarItem.Status.ok,
  });

  const terminal = vscode.window.createTerminal(plan.terminalName);
  terminal.show();

  logEvent('ssh.launch.started', {
    commandId: plan.observability.commandId,
    profileName: plan.profileName,
    host: plan.destination.host,
    port: plan.destination.port,
    hops: plan.transport.hops.map(hop => `${hop.username}@${hop.host}:${hop.port}`),
    issues: plan.issues.map(issue => issue.code),
    commandLine: command.logText,
  });

  for (const issue of plan.issues) {
    logger.warn(issue.message, issue.code);
  }

  try {
    const shellIntegration = await waitForShellIntegration(terminal, 5000);
    const execution = shellIntegration.executeCommand(command.command, command.args);
    const outputPromise = collectExecutionOutput(execution);
    const endPromise = waitForExecutionEnd(terminal, execution);

    let established = false;
    const establishedTimer = setTimeout(() => {
      if (established) {
        return;
      }
      established = true;
      activity.update({
        spinning: false,
        text: `$(check) SSH ${plan.profileName}: connected`,
        status: StatusBarItem.Status.ok,
      });
      setTimeout(() => activity.dispose(), 2500);
      logEvent('ssh.launch.established', {
        commandId: plan.observability.commandId,
        profileName: plan.profileName,
        host: plan.destination.host,
        port: plan.destination.port,
      });
    }, plan.observability.failureWindowMs);

    const endEvent = await endPromise;
    const outputText = await outputPromise;
    clearTimeout(establishedTimer);

    const failureHint = detectFailureHint(outputText);
    const failedBeforeEstablished =
      !established && (failureHint !== null || endEvent.exitCode === undefined || endEvent.exitCode !== 0);

    if (failedBeforeEstablished) {
      const reason = failureHint || `exit code ${String(endEvent.exitCode)}`;
      logEvent('ssh.launch.failed', {
        commandId: plan.observability.commandId,
        profileName: plan.profileName,
        host: plan.destination.host,
        port: plan.destination.port,
        exitCode: endEvent.exitCode,
        failureReason: reason,
        terminalDisposition: 'auto_closed',
      });
      activity.update({
        spinning: false,
        text: `$(error) SSH ${plan.profileName}: failed`,
        status: StatusBarItem.Status.error,
      });
      setTimeout(() => activity.dispose(), 4000);
      notifyFailure(`Open SSH in Terminal failed for "${plan.profileName}".`);
      terminal.dispose();
      return {
        result: 'failed',
        exitCode: endEvent.exitCode,
      };
    }

    logEvent('ssh.launch.completed', {
      commandId: plan.observability.commandId,
      profileName: plan.profileName,
      host: plan.destination.host,
      port: plan.destination.port,
      exitCode: endEvent.exitCode,
      established,
      terminalDisposition: 'kept',
    });
    if (!established) {
      activity.update({
        spinning: false,
        text: `$(check) SSH ${plan.profileName}: completed`,
        status: StatusBarItem.Status.ok,
      });
      setTimeout(() => activity.dispose(), 2500);
      return {
        result: 'completed',
        exitCode: endEvent.exitCode,
      };
    }

    return {
      result: 'established',
      exitCode: endEvent.exitCode,
    };
  } catch (error) {
    logEvent('ssh.launch.failed', {
      commandId: plan.observability.commandId,
      profileName: plan.profileName,
      host: plan.destination.host,
      port: plan.destination.port,
      failureReason: error instanceof Error ? error.message : String(error),
      terminalDisposition: 'auto_closed',
    });
    activity.update({
      spinning: false,
      text: `$(error) SSH ${plan.profileName}: failed`,
      status: StatusBarItem.Status.error,
    });
    setTimeout(() => activity.dispose(), 4000);
    notifyFailure(`Open SSH in Terminal failed for "${plan.profileName}".`);
    terminal.dispose();
    throw error;
  }
}
