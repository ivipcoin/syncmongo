import { Storage } from ".";
import { StorageReference } from "./StorageReference";
import path from "path";
import fs from "fs";
import { Mime, getExtension } from "../utils";
import { fileTypeFromBuffer } from "../controller/file-type";

export class StorageServer {
	constructor(protected storage: Storage) {}

	async put(
		ref: StorageReference,
		data: Uint8Array | Buffer,
		metadata?: { contentType: string },
		onStateChanged?: (event: { bytesTransferred: number; totalBytes?: number; state: string; metadata: any; task: string; ref: StorageReference }) => void,
	): Promise<string> {
		const localPath: string = this.storage.app.settings.server?.localPath ?? "./data";
		const dbName = this.storage.database.name;

		const dataBuffer = Buffer.from(data);

		const dirUpload = path.resolve(localPath, `./${dbName}/storage-uploads`);
		if (!fs.existsSync(dirUpload)) {
			fs.mkdirSync(dirUpload, { recursive: true });
		}

		const db_ref = this.storage.database.ref(`__storage__`).child(ref.fullPath);

		const snapshot = await db_ref.get();

		if (snapshot.exists()) {
			const { path: _path } = snapshot.val();

			if (typeof _path === "string") {
				const storage_path = path.resolve(localPath, `./${dbName}`, _path);
				if (fs.existsSync(storage_path)) {
					fs.unlinkSync(storage_path);
				}

				await db_ref.remove();
			}
		}
		let extensionFile = getExtension(ref.fullPath) || "";
		let mimetype = metadata?.contentType ?? "application/octet-binary";

		if (!metadata?.contentType) {
			const type = await fileTypeFromBuffer(dataBuffer);

			if (type?.mime) {
				mimetype = type.mime;
			} else if (!type && typeof extensionFile === "string" && extensionFile.trim() !== "") {
				mimetype = Mime.getType(ref.fullPath);
			} else {
				mimetype = "application/octet-binary";
			}
		}

		let file = {
			filename: `file-${Date.now()}`,
			mimetype: mimetype,
			size: dataBuffer.length,
		};

		await new Promise<void>((resolve, reject) => {
			const stream = fs.createWriteStream(path.resolve(dirUpload, file.filename));
			const chunkSize = 1024 * 1024; // 1MB

			const writeNextChunk = (start: number) => {
				const end = Math.min(start + chunkSize, dataBuffer.length);
				// const chunk = Buffer.from(dataBuffer.buffer, start, end - start);
				const chunk = dataBuffer.slice(start, end);
				stream.write(chunk);

				if (onStateChanged) {
					onStateChanged({
						bytesTransferred: end,
						totalBytes: dataBuffer.length,
						state: "completed",
						metadata: {},
						task: "write",
						ref,
					});
				}

				if (end < dataBuffer.length) {
					setTimeout(() => {
						writeNextChunk(end);
					}, 10);
				} else {
					stream.end();
				}
			};

			stream.once("open", () => {
				writeNextChunk(0);
			});

			stream.once("close", () => {
				if (onStateChanged) {
					onStateChanged({
						bytesTransferred: dataBuffer.length,
						totalBytes: dataBuffer.length,
						state: "completed",
						metadata: {},
						task: "write",
						ref,
					});
				}

				resolve();
			});

			stream.once("error", (err) => {
				console.error("Erro ao escrever no arquivo:", err);
				if (onStateChanged) {
					onStateChanged({
						bytesTransferred: 0,
						totalBytes: dataBuffer.length,
						state: "error",
						metadata: {},
						task: "write",
						ref,
					});
				}

				reject(err);
			});
		});

		// fs.writeFileSync(path.resolve(dirUpload, file.filename), dataBuffer);

		const storage = {
			path: `storage-uploads/${file.filename}`,
			isFile: true,
			metadata: {
				contentType: mimetype,
				size: file.size,
			},
		};

		await db_ref.set(storage);

		return Promise.resolve(ref.fullPath);
	}

	putString(
		ref: StorageReference,
		data: string,
		type?: "base64" | "base64url" | "data_url" | "raw" | "text",
		onStateChanged?: (event: { bytesTransferred: number; totalBytes?: number; state: string; metadata: any; task: string; ref: StorageReference }) => void,
	): Promise<string> {
		if (type === "data_url") {
			const [_, base64] = data.split(",");
			data = base64;
			type = "base64";
		} else if (type === "base64url") {
			data = data.replace(/-/g, "+").replace(/_/g, "/");
			type = "base64";
		}

		const dataBuffer = Buffer.from(data, type === "base64" ? "base64" : "utf-8");
		return this.put(ref, dataBuffer, undefined, onStateChanged);
	}

	async delete(ref: StorageReference): Promise<void> {
		const localPath: string = this.storage.app.settings.server?.localPath ?? "./data";
		const dbName = this.storage.database.name;

		const dirUpload = path.resolve(localPath, `./${dbName}/storage-uploads`);
		if (!fs.existsSync(dirUpload)) {
			fs.mkdirSync(dirUpload, { recursive: true });
		}

		const db_ref = this.storage.database.ref(`__storage__`).child(ref.fullPath);

		const snapshot = await db_ref.get();

		if (snapshot.exists()) {
			const { path: _path } = snapshot.val();

			if (typeof _path === "string") {
				const storage_path = path.resolve(localPath, `./${dbName}`, _path);
				if (fs.existsSync(storage_path)) {
					fs.unlinkSync(storage_path);
				}

				await db_ref.remove();
			}
		}

		return Promise.resolve();
	}

	async getDownloadURL(ref: StorageReference): Promise<string | null> {
		const { path, isFile } = await this.storage.database
			.ref(`__storage__`)
			.child(ref.fullPath)
			.get({
				include: ["path", "isFile"],
			})
			.then((snap) =>
				Promise.resolve(
					snap.val() ?? {
						path: null,
						isFile: false,
					},
				),
			)
			.catch(() =>
				Promise.resolve({
					path: null,
					isFile: false,
				}),
			);

		return typeof path === "string" && isFile ? `${this.storage.app.url}/storage/${this.storage.database.name}/${ref.fullPath}` : null;
	}

	async listAll(ref: StorageReference): Promise<{
		prefixes: StorageReference[];
		items: StorageReference[];
	}> {
		const snaps = await this.storage.database.query(`__storage__/${ref.fullPath}`).get({
			include: ["path", "isFile"],
		});

		const items: string[] = [];
		const prefixes: string[] = [];

		snaps.forEach((snap) => {
			const { path, isFile } = snap.val();
			if (typeof path === "string" && isFile) {
				items.push(snap.ref.path.replace(`__storage__/${ref.fullPath}/`, ""));
			} else {
				prefixes.push(path.ref.path.replace(`__storage__/${ref.fullPath}/`, ""));
			}
		});

		return {
			items: items
				.sort((a, b) => {
					return String(a).localeCompare(b);
				})
				.map((child) => {
					return ref.child(child);
				}),
			prefixes: prefixes
				.sort((a, b) => {
					return String(a).localeCompare(b);
				})
				.map((child) => {
					return ref.child(child);
				}),
		};
	}

	async list(
		ref: StorageReference,
		config: {
			maxResults?: number;
			page?: number;
		},
	): Promise<{
		more: boolean;
		page: number;
		items: StorageReference[];
		prefixes: StorageReference[];
	}> {
		const maxResults = config.maxResults ?? 10;
		const skip = (config.page ?? 0) * maxResults;

		const { items, prefixes } = await this.listAll(ref);

		const length = items.length + prefixes.length;

		return {
			more: length > maxResults + skip,
			page: config.page ?? 0,
			items: items.filter((_, i) => {
				const index = i + prefixes.length;
				return index >= skip && index < maxResults + skip;
			}),
			prefixes: prefixes.filter((_, index) => {
				return index >= skip && index < maxResults + skip;
			}),
		};
	}
}
