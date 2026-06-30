import * as vscode from 'vscode';

const spinners = {
  dots: {
    interval: 80,
    frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  },
};

enum Status {
  ok = 1,
  warn,
  error,
}

interface ActivityState {
  id: string;
  priority: number;
  status: Status;
  text: string;
  tooltip?: string;
  spinning: boolean;
  seq: number;
}

interface ActivityUpdate {
  priority?: number;
  status?: Status;
  text?: string;
  tooltip?: string;
  spinning?: boolean;
}

export interface ActivityHandle {
  update(update: ActivityUpdate): void;
  dispose(): void;
}

export default class StatusBarItem {
  static Status = Status;

  private _name: () => string | string;
  private tooltip: string;
  private statusBarItem: vscode.StatusBarItem;
  private spinnerTimer: any = null;
  private curFrameOfSpinner: number = 0;
  private text: string;
  private status: Status = Status.ok;
  private spinner: {
    interval: number;
    frames: string[];
  };
  private activities = new Map<string, ActivityState>();
  private activitySeq: number = 0;
  private activityTimers = new Map<string, NodeJS.Timeout>();

  constructor(name, tooltip, command) {
    this._name = name;
    this.tooltip = tooltip;
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    this.statusBarItem.command = command;
    this.spinner = spinners.dots;
    this.reset = this.reset.bind(this);
    this.reset();
  }

  private get name() {
    return typeof this._name === 'function' ? this._name() : this._name;
  }

  updateStatus(status: Status) {
    this.status = status;
    this._render();
  }

  createActivity(id: string, initial: ActivityUpdate & { priority?: number } = {}): ActivityHandle {
    const handle: ActivityHandle = {
      update: (update: ActivityUpdate) => {
        const current = this.activities.get(id);
        this.activities.set(id, {
          id,
          priority: update.priority ?? initial.priority ?? current?.priority ?? 0,
          status: update.status ?? current?.status ?? initial.status ?? Status.ok,
          text: update.text ?? current?.text ?? initial.text ?? this.name,
          tooltip: update.tooltip ?? current?.tooltip ?? initial.tooltip,
          spinning: update.spinning ?? current?.spinning ?? initial.spinning ?? false,
          seq: ++this.activitySeq,
        });
        this._render();
      },
      dispose: () => {
        this._clearActivityTimer(id);
        this.activities.delete(id);
        this._render();
      },
    };

    handle.update({});
    return handle;
  }

  showActivity(
    id: string,
    initial: ActivityUpdate & { priority?: number },
    hideAfterTimeout?: number
  ) {
    const handle = this.createActivity(id, initial);
    if (hideAfterTimeout) {
      this._clearActivityTimer(id);
      const timer = setTimeout(() => {
        this.activityTimers.delete(id);
        handle.dispose();
      }, hideAfterTimeout);
      this.activityTimers.set(id, timer);
    }
    return handle;
  }

  getText() {
    return this.statusBarItem.text;
  }

  show() {
    this.statusBarItem.show();
  }

  isSpinning() {
    return this.spinnerTimer !== null;
  }

  startSpinner() {
    this.showActivity('__legacy_spinner__', {
      priority: 70,
      spinning: true,
      status: this.status,
      text: this._getTopActivity()?.text ?? this.text ?? this.name,
      tooltip: typeof this.statusBarItem.tooltip === 'string'
        ? this.statusBarItem.tooltip
        : this.tooltip,
    });
  }

  stopSpinner() {
    this._clearActivityTimer('__legacy_spinner__');
    this.activities.delete('__legacy_spinner__');
    this._render();
  }

  showMsg(text: string, hideAfterTimeout?: number);
  showMsg(text: string, tooltip: string, hideAfterTimeout?: number);
  showMsg(text: string, tooltip?: string | number, hideAfterTimeout?: number) {
    if (typeof tooltip === 'number') {
      hideAfterTimeout = tooltip;
      tooltip = text;
    }
    this.showActivity(
      '__legacy_message__',
      {
        priority: 60,
        status: this.status,
        text,
        tooltip: tooltip as string | undefined,
      },
      hideAfterTimeout
    );
  }

  private _render() {
    const active = this._getTopActivity();
    const text = active?.text ?? this.name;
    const tooltip = active?.tooltip ?? this.tooltip;
    const status = active?.status ?? this.status;

    this.text = text;
    this.statusBarItem.tooltip = tooltip;

    if (active?.spinning) {
      this._ensureSpinner();
      this.statusBarItem.text = this.spinner.frames[this.curFrameOfSpinner] + ' ' + text;
      return;
    }

    this._stopSpinnerInterval();

    if (this.name === text) {
      switch (status) {
        case Status.ok:
          this.statusBarItem.text = text;
          break;
        case Status.warn:
          this.statusBarItem.text = `$(alert) ${text}`;
          break;
        case Status.error:
          this.statusBarItem.text = `$(issue-opened) ${text}`;
          break;
        default:
          this.statusBarItem.text = text;
      }
    } else {
      this.statusBarItem.text = text;
    }
  }

  reset() {
    this._clearActivityTimer('__legacy_spinner__');
    this._clearActivityTimer('__legacy_message__');
    this.activities.delete('__legacy_spinner__');
    this.activities.delete('__legacy_message__');
    this._render();
  }

  private _getTopActivity() {
    return [...this.activities.values()].sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return b.seq - a.seq;
    })[0];
  }

  private _ensureSpinner() {
    if (this.spinnerTimer) {
      return;
    }

    const totalFrame = this.spinner.frames.length;
    this.spinnerTimer = setInterval(() => {
      this.curFrameOfSpinner = (this.curFrameOfSpinner + 1) % totalFrame;
      this._render();
    }, this.spinner.interval);
  }

  private _stopSpinnerInterval() {
    if (!this.spinnerTimer) {
      return;
    }

    clearInterval(this.spinnerTimer);
    this.spinnerTimer = null;
    this.curFrameOfSpinner = 0;
  }

  private _clearActivityTimer(id: string) {
    const timer = this.activityTimers.get(id);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.activityTimers.delete(id);
  }
}
