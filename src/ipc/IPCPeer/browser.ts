import { ID, Transport } from "ivipbase-core";
import { IvipBaseIPCPeer, IMessage } from "../ipc";

type MessageEventCallback = (event: MessageEvent) => any;

/**
 * Browser tabs IPC. Database changes and events will be synchronized automatically.
 * Locking of resources will be done by the election of a single locking master:
 * the one with the lowest id.
 */
export class IPCPeer extends IvipBaseIPCPeer {
	private channel?: BroadcastChannel;

	constructor(protected name: string) {
		super("browser", name);

		this.masterPeerId = this.id; // We don't know who the master is yet...
		this.ipcType = "browser.bcc";

		// Setup process exit handler
		// Monitor onbeforeunload event to say goodbye when the window is closed
		addEventListener("beforeunload", () => {
			this.exit();
		});

		// Create BroadcastChannel to allow multi-tab communication
		// This allows other tabs to make changes to the database, notifying us of those changes.
		if (typeof BroadcastChannel !== "undefined") {
			this.channel = new BroadcastChannel(`ivipbase:${name}`);
		} else if (typeof localStorage !== "undefined") {
			// Use localStorage as polyfill for Safari & iOS WebKit
			const listeners: MessageEventCallback[] = []; // first callback reserved for onmessage handler
			const notImplemented = () => {
				throw new Error("Not implemented");
			};
			this.channel = {
				name: `ivipbase:${name}`,
				postMessage: (message: any) => {
					const messageId = ID.generate(),
						key = `ivipbase:${name}:${this.id}:${messageId}`,
						payload = JSON.stringify(Transport.serialize(message));

					// Store message, triggers 'storage' event in other tabs
					localStorage.setItem(key, payload);

					// Remove after 10ms
					setTimeout(() => localStorage.removeItem(key), 10);
				},
				set onmessage(handler: MessageEventCallback) {
					listeners[0] = handler;
				},
				set onmessageerror(handler: MessageEventCallback) {
					notImplemented();
				},
				close() {
					notImplemented();
				},
				addEventListener(event: "message", callback: MessageEventCallback) {
					if (event !== "message") {
						notImplemented();
					}
					listeners.push(callback);
				},
				removeEventListener(event: "message", callback: MessageEventCallback) {
					const i = listeners.indexOf(callback);
					i >= 1 && listeners.splice(i, 1);
				},
				dispatchEvent(event: MessageEvent) {
					listeners.forEach((callback) => {
						try {
							callback && callback(event);
						} catch (err) {
							console.error(err);
						}
					});
					return true;
				},
			} as BroadcastChannel;

			// Listen for storage events to intercept possible messages
			addEventListener("storage", (event) => {
				if (!event || !event.key) {
					return;
				}

				const [ivipbase, name, peerId, messageId] = event.key.split(":");
				if (ivipbase !== "ivipbase" || name !== this.name || peerId === this.id || event.newValue === null) {
					return;
				}
				const message = Transport.deserialize(JSON.parse(event.newValue));
				this.channel?.dispatchEvent({ data: message } as MessageEvent);
			});
		} else {
			// No localStorage either, this is probably an old browser running in a webworker
			this.debug.warn(`[BroadcastChannel] not supported`);
			this.sendMessage = () => {
				/* No OP */
			};
			return;
		}

		// Monitor incoming messages
		this.channel.addEventListener("message", async (event) => {
			const message: IMessage = event.data;

			if (message.to && message.to !== this.id) {
				// Message is for somebody else. Ignore
				return;
			}

			this.debug.verbose(`[BroadcastChannel] received: `, message);

			if (message.type === "hello" && message.from < this.masterPeerId) {
				// This peer was created before other peer we thought was the master
				this.masterPeerId = message.from;
				this.debug.log(`[BroadcastChannel] Tab ${this.masterPeerId} is the master.`);
			} else if (message.type === "bye" && message.from === this.masterPeerId) {
				// The master tab is leaving
				this.debug.log(`[BroadcastChannel] Master tab ${this.masterPeerId} is leaving`);

				// Elect new master
				const allPeerIds = this.peers
					.map((peer) => peer.id)
					.concat(this.id)
					.filter((id) => id !== this.masterPeerId); // All peers, including us, excluding the leaving master peer
				this.masterPeerId = allPeerIds.sort()[0];
			}

			return this.handleMessage(message);
		});

		// // Schedule periodic "pulse" to let others know we're still around
		// setInterval(() => {
		//     sendMessage(<IPulseMessage>{ from: tabId, type: 'pulse' });
		// }, 30000);

		this.emit("connect", this);
	}

	sendMessage(message: IMessage) {
		this.debug.verbose(`[BroadcastChannel] sending: `, message);
		this.channel?.postMessage(message);
	}
}
