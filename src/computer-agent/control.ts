import { randomUUID } from 'node:crypto';

export interface ControlState {
  holder: 'bot' | 'human';
  requested: boolean;
  transitioning: boolean;
  resumeSnapshotRequired: boolean;
  request?: { id: string; status: string };
}

export class ControlError extends Error {
  readonly status = 409;
}

/**
 * Who drives the browser. The owner asks for control, takes it, and hands it
 * back; while the owner holds it, the Dot's browser actions are refused, and
 * after a handback the Dot must take a fresh snapshot before acting.
 */
export class Control {
  private state: ControlState = {
    holder: 'bot',
    requested: false,
    transitioning: false,
    resumeSnapshotRequired: false,
  };

  get value(): ControlState {
    return structuredClone(this.state);
  }

  request(reason = 'Owner requested control.') {
    void reason;
    if (this.state.holder === 'human') return this.value;
    if (!this.state.request || this.state.request.status !== 'waiting')
      this.state.request = { id: randomUUID(), status: 'waiting' };
    this.state.requested = true;
    return this.value;
  }

  take(requestId: string) {
    if (this.state.request?.id !== requestId)
      throw new ControlError('That control request is no longer current.');
    this.state = {
      holder: 'human',
      requested: false,
      transitioning: false,
      resumeSnapshotRequired: false,
      request: { id: requestId, status: 'taken' },
    };
    return this.value;
  }

  release(requestId: string) {
    if (this.state.request?.id !== requestId)
      throw new ControlError('That control request is no longer current.');
    this.state = {
      holder: 'bot',
      requested: false,
      transitioning: false,
      resumeSnapshotRequired: true,
      request: { id: requestId, status: 'released' },
    };
    return this.value;
  }

  /** Throws for Dot browser actions while the owner holds control. */
  requireBot() {
    if (this.state.holder === 'human')
      throw new ControlError(
        'The owner has control of this browser. Wait for them to release it.',
      );
  }

  /** A fresh snapshot after handback lets the Dot act again. */
  snapshotTaken() {
    this.state.resumeSnapshotRequired = false;
  }

  requireFreshSnapshot() {
    if (this.state.resumeSnapshotRequired)
      throw new ControlError(
        'Control was handed back; take computer_snapshot before acting.',
      );
  }
}
