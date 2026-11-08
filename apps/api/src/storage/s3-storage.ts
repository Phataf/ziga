import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { assertSafeKey, type StorageAdapter } from './storage.js';

export interface S3Options {
	endpoint: string;
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	forcePathStyle: boolean;
	timeoutMs: number;
}

/** Stockage compatible S3 (SeaweedFS en développement, fournisseur S3 en production). */
export class S3Storage implements StorageAdapter {
	readonly driver = 's3' as const;
	private readonly client: S3Client;

	constructor(private readonly options: S3Options) {
		this.client = new S3Client({
			endpoint: options.endpoint,
			region: options.region,
			forcePathStyle: options.forcePathStyle,
			credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
			maxAttempts: 1,
			requestHandler: { requestTimeout: options.timeoutMs, connectionTimeout: options.timeoutMs }
		});
	}

	async check(): Promise<void> {
		await this.client.send(new HeadBucketCommand({ Bucket: this.options.bucket }));
	}

	async put(key: string, body: Buffer, contentType: string): Promise<void> {
		assertSafeKey(key);
		await this.client.send(new PutObjectCommand({ Bucket: this.options.bucket, Key: key, Body: body, ContentType: contentType }));
	}

	async get(key: string): Promise<Buffer> {
		assertSafeKey(key);
		const out = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }));
		return Buffer.from(await out.Body!.transformToByteArray());
	}

	async delete(key: string): Promise<void> {
		assertSafeKey(key);
		await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
	}

	destroy(): void {
		this.client.destroy();
	}
}
