/**
 * Runs a render on request, except while something is being dragged over the surface it
 * draws on.
 *
 * A browser delivers `drop` to whichever element was under the pointer at the last drag
 * event. If a render replaces that element in between, the drop goes to the removed element
 * and never reaches listeners on its former ancestors. So renders requested during a drag
 * are held back and collapse into one render when the drag ends.
 *
 * Whether a drag is over the surface is tracked by counting, because of the order Chromium
 * delivers events in when the pointer moves from one child to another: `dragenter` on the
 * new child, then `dragleave` on the old one, and no `dragover` until the pointer moves again.
 */
export class DragAwareRender {
	/** How long without any drag event before holding is abandoned, so the surface cannot stay frozen. */
	static readonly IDLE_TIMEOUT_MS = 5000;

	private render: () => void;
	/** Elements of the surface the drag has entered and not yet left; above zero while it is over the surface. */
	private depth = 0;
	private renderPending = false;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(render: () => void) {
		this.render = render;
	}

	/** Renders now, or once the drag in progress has ended. */
	public request(): void {
		if (this.depth > 0) {
			this.renderPending = true;
			return;
		}
		this.render();
	}

	/** Call on `dragenter`. */
	public dragEntered(): void {
		this.depth++;
		this.restartIdleTimer();
	}

	/** Call on `dragover`. */
	public dragOver(): void {
		// Evidently over the surface, whatever the count says.
		this.depth = Math.max(this.depth, 1);
		this.restartIdleTimer();
	}

	/** Call on `dragleave`. */
	public dragLeft(): void {
		if (this.depth === 0) return;
		this.depth--;
		if (this.depth === 0) {
			this.release();
		} else {
			this.restartIdleTimer();
		}
	}

	/** Call on `drop`, once the drop has been handled. */
	public dropped(): void {
		this.release();
	}

	public dispose(): void {
		this.clearIdleTimer();
		this.depth = 0;
		this.renderPending = false;
	}

	private restartIdleTimer(): void {
		this.clearIdleTimer();
		this.idleTimer = setTimeout(() => this.release(), DragAwareRender.IDLE_TIMEOUT_MS);
	}

	private release(): void {
		this.clearIdleTimer();
		this.depth = 0;
		if (this.renderPending) {
			this.renderPending = false;
			this.render();
		}
	}

	private clearIdleTimer(): void {
		if (this.idleTimer !== null) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
	}
}
