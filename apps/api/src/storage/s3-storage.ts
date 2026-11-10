import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadBucketCommand,
	HeadObjectCommand,
	NotFound,
	PutObjectCommand,
	S3Client,
	S3ServiceException
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { assertSafeKey, attachment, type PresignedUpload, type StorageAdapter } from './storage.js';

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
			requestHandler: { requestTimeout: options.timeoutMs, connectionTimeout: options.timeoutMs },
			// Pas de somme de contrôle automatique : dans une URL présignée, elle porterait sur un corps vide et le
			// stockage refuserait le vrai fichier (BadDigest). La taille et le type, eux, sont signés.
			requestChecksumCalculation: 'WHEN_REQUIRED',
			responseChecksumValidation: 'WHEN_REQUIRED'
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

	async stat(key: string): Promise<{ size: number; contentType: string | null } | null> {
		assertSafeKey(key);
		try {
			const out = await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }));
			return { size: out.ContentLength ?? 0, contentType: out.ContentType ?? null };
		} catch (error) {
			if (error instanceof NotFound || (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404)) return null;
			throw error;
		}
	}

	async presignPut(
		key: string,
		options: { contentType: string; contentLength: number; expiresInSeconds: number }
	): Promise<PresignedUpload> {
		assertSafeKey(key);
		const command = new PutObjectCommand({
			Bucket: this.options.bucket,
			Key: key,
			ContentType: options.contentType,
			ContentLength: options.contentLength
		});
		// Type et taille dans la signature : un autre corps est refusé par le stockage (SignatureDoesNotMatch).
		const url = await getSignedUrl(this.client, command, {
			expiresIn: options.expiresInSeconds,
			signableHeaders: new Set(['content-type', 'content-length'])
		});
		return {
			url,
			method: 'PUT',
			headers: { 'content-type': options.contentType, 'content-length': String(options.contentLength) },
			expiresAt: new Date(Date.now() + options.expiresInSeconds * 1000).toISOString()
		};
	}

	async presignGet(key: string, options: { expiresInSeconds: number; fileName?: string; contentType?: string }): Promise<string> {
		assertSafeKey(key);
		const command = new GetObjectCommand({
			Bucket: this.options.bucket,
			Key: key,
			ResponseContentDisposition: options.fileName ? attachment(options.fileName) : undefined,
			ResponseContentType: options.contentType,
			// Jamais en cache : ni le navigateur, ni un intermédiaire ne gardent un document privé.
			ResponseCacheControl: 'private, no-store'
		});
		return getSignedUrl(this.client, command, { expiresIn: options.expiresInSeconds });
	}

	destroy(): void {
		this.client.destroy();
	}
}
