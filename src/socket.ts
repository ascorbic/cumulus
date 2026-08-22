export interface SocketOptions {
	/** Stop reading after this long. */
	budgetMs: number;
	/** Treat the stream as caught up after this long without a frame. */
	idleMs: number;
	now: () => number;
}

export type Frame = ArrayBuffer | Blob | string;

/**
 * Opens an outbound websocket and yields raw frames until the stream goes
 * idle or the budget elapses. Outbound sockets cannot hibernate, so one
 * lives only for the duration of a drain.
 */
export async function* readSocket(
	url: string,
	{ budgetMs, idleMs, now }: SocketOptions,
): AsyncGenerator<Frame> {
	// Workers open websockets with an HTTP(S) upgrade request, not a ws(s): URL.
	const target = new URL(url);
	if (target.protocol === "wss:") target.protocol = "https:";
	if (target.protocol === "ws:") target.protocol = "http:";
	const response = await fetch(target.href, { headers: { upgrade: "websocket" } });
	const socket = response.webSocket;
	if (!socket) {
		await response.body?.cancel();
		throw new Error(`websocket upgrade failed with ${response.status}`);
	}

	const queue: Frame[] = [];
	let wake: (() => void) | undefined;
	let closed = false;
	const signal = () => {
		wake?.();
		wake = undefined;
	};
	socket.addEventListener("message", (event) => {
		queue.push(event.data as Frame);
		signal();
	});
	socket.addEventListener("close", () => {
		closed = true;
		signal();
	});
	socket.addEventListener("error", () => {
		closed = true;
		signal();
	});
	socket.accept();

	const deadline = now() + budgetMs;
	try {
		for (;;) {
			while (queue.length > 0) yield queue.shift()!;
			if (closed) return;
			const wait = Math.min(idleMs, deadline - now());
			if (wait <= 0) return;
			const woke = await new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => resolve(false), wait);
				wake = () => {
					clearTimeout(timer);
					resolve(true);
				};
			});
			if (!woke && queue.length === 0) return;
		}
	} finally {
		try {
			socket.close(1000, "drain complete");
		} catch {
			// Already closed by the peer.
		}
	}
}

export async function frameBytes(frame: Frame): Promise<Uint8Array | undefined> {
	if (typeof frame === "string") return undefined;
	return new Uint8Array(frame instanceof Blob ? await frame.arrayBuffer() : frame);
}
