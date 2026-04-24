import crypto from "crypto";
import {
  CompareFacesCommand,
  CreateFaceLivenessSessionCommand,
  GetFaceLivenessSessionResultsCommand,
  type CompareFacesMatch,
  type RekognitionClient,
} from "@aws-sdk/client-rekognition";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { Logger } from "../../logger";
import { noopLogger } from "../../logger";

export interface FaceLivenessServiceOptions {
  rekognition: Pick<RekognitionClient, "send">;
  sts: Pick<STSClient, "send">;
  dynamo: Pick<DynamoDBDocumentClient, "send">;
  logger?: Logger;
  config: {
    region: string;
    livenessRoleArn?: string;
    livenessBootstrapTable?: string;
    livenessRoleSessionName: string;
    livenessPagesUrl: string;
    livenessTokenTtlSeconds: number;
    livenessPollIntervalSeconds: number;
    livenessMaxPollSeconds: number;
    livenessConfidenceThreshold: number;
    faceSimilarityThreshold: number;
  };
}

export class FaceLivenessService {
  private readonly rekognition: Pick<RekognitionClient, "send">;
  private readonly sts: Pick<STSClient, "send">;
  private readonly dynamo: Pick<DynamoDBDocumentClient, "send">;
  private readonly logger: Logger;
  private readonly config: FaceLivenessServiceOptions["config"];

  constructor({
    rekognition,
    sts,
    dynamo,
    logger = noopLogger,
    config,
  }: FaceLivenessServiceOptions) {
    this.rekognition = rekognition;
    this.sts = sts;
    this.dynamo = dynamo;
    this.logger = logger;
    this.config = config;
  }

  async createAttempt({
    userId,
    profilePhotoFileId,
  }: {
    userId: number;
    profilePhotoFileId: string;
  }): Promise<FaceLivenessAttempt> {
    if (!this.config.livenessRoleArn || !this.config.livenessBootstrapTable) {
      throw new Error("Face liveness is not configured");
    }

    const session = await this.rekognition.send(new CreateFaceLivenessSessionCommand({}));
    const sessionId = session.SessionId;
    if (!sessionId) throw new Error("CreateFaceLivenessSession did not return a session ID");

    const token = crypto.randomBytes(24).toString("base64url");
    const expiresAt = Math.floor(Date.now() / 1000) + this.config.livenessTokenTtlSeconds;
    const credentials = await this.createBootstrapCredentials(token);
    await this.dynamo.send(
      new PutCommand({
        TableName: this.config.livenessBootstrapTable,
        Item: {
          token,
          sessionId,
          region: this.config.region,
          userId,
          profilePhotoFileId,
          stsAccessKeyId: credentials.accessKeyId,
          stsSecretAccessKey: credentials.secretAccessKey,
          stsSessionToken: credentials.sessionToken,
          expiresAt,
          ttl: expiresAt,
        },
      }),
    );

    return {
      sessionId,
      token,
      url: `${this.config.livenessPagesUrl}?token=${encodeURIComponent(token)}`,
      expiresAt,
      profilePhotoFileId,
    };
  }

  async pollForResult({
    sessionId,
    expectedProfilePhotoFileId,
    currentProfilePhotoFileId,
    profilePhotoBuffer,
  }: {
    sessionId: string;
    expectedProfilePhotoFileId: string;
    currentProfilePhotoFileId: string | null;
    profilePhotoBuffer: Buffer;
  }): Promise<FaceLivenessPollResult> {
    const deadline = Date.now() + this.config.livenessMaxPollSeconds * 1000;
    while (Date.now() < deadline) {
      const result = await this.rekognition.send(
        new GetFaceLivenessSessionResultsCommand({ SessionId: sessionId }),
      );
      const status = result.Status;
      if (status === "SUCCEEDED") {
        if (currentProfilePhotoFileId !== expectedProfilePhotoFileId) {
          return {
            status: "photo_changed",
            userMessage:
              "Your profile photo changed before the liveness check finished. Please start a new check.",
          };
        }
        const referenceBytes = result.ReferenceImage?.Bytes;
        if (!referenceBytes) {
          return {
            status: "failed",
            userMessage:
              "The liveness check completed, but we couldn't verify it. Please try again.",
          };
        }
        const similarity = await this.compareReferenceImage({
          sourceImage: profilePhotoBuffer,
          targetImage: Buffer.from(referenceBytes),
        });
        const confidence = result.Confidence ?? 0;
        if (
          confidence < this.config.livenessConfidenceThreshold ||
          similarity < this.config.faceSimilarityThreshold
        ) {
          return {
            status: "failed",
            confidence,
            similarity,
            userMessage:
              "That liveness check didn't match your profile photo closely enough. Please try again.",
          };
        }
        return {
          status: "succeeded",
          confidence,
          similarity,
          userMessage: "Face liveness check complete. You're verified for this photo.",
        };
      }

      if (status === "FAILED" || status === "EXPIRED") {
        return {
          status: status === "EXPIRED" ? "expired" : "failed",
          confidence: result.Confidence ?? 0,
          userMessage:
            status === "EXPIRED"
              ? "That liveness link expired. Please start a new check."
              : "That liveness check failed. Please try again.",
        };
      }

      await delay(this.config.livenessPollIntervalSeconds * 1000);
    }

    return {
      status: "expired",
      userMessage: "That liveness link expired. Please start a new check.",
    };
  }

  private async createBootstrapCredentials(token: string) {
    const response = await this.sts.send(
      new AssumeRoleCommand({
        RoleArn: this.config.livenessRoleArn,
        RoleSessionName: `${this.config.livenessRoleSessionName}-${token.slice(0, 8)}`,
        DurationSeconds: 900,
      }),
    );
    const credentials = response.Credentials;
    if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
      throw new Error("AssumeRole did not return complete credentials");
    }
    return {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
    };
  }

  private async compareReferenceImage({
    sourceImage,
    targetImage,
  }: {
    sourceImage: Buffer;
    targetImage: Buffer;
  }): Promise<number> {
    const response = await this.rekognition.send(
      new CompareFacesCommand({
        SimilarityThreshold: this.config.faceSimilarityThreshold,
        SourceImage: { Bytes: sourceImage },
        TargetImage: { Bytes: targetImage },
      }),
    );
    return highestSimilarity(response.FaceMatches ?? []);
  }
}

export interface FaceLivenessAttempt {
  sessionId: string;
  token: string;
  url: string;
  expiresAt: number;
  profilePhotoFileId: string;
}

export type FaceLivenessPollResult =
  | {
      status: "succeeded";
      confidence: number;
      similarity: number;
      userMessage: string;
    }
  | {
      status: "failed" | "expired" | "photo_changed";
      confidence?: number;
      similarity?: number;
      userMessage: string;
    };

function highestSimilarity(matches: CompareFacesMatch[]): number {
  return matches.reduce((max, match) => Math.max(max, match.Similarity ?? 0), 0);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createAwsClients(region: string) {
  const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  return {
    dynamo,
    sts: new STSClient({ region }),
  };
}
