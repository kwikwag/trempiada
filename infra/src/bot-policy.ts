import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export type BotIdentityPolicy = {
  policy: aws.iam.Policy;
  document: pulumi.Output<string>;
};

export function createBotIdentityPolicy(args: {
  resourcePrefix: string;
  tokenTableArn: pulumi.Input<string>;
  browserSessionRoleArn: pulumi.Input<string>;
  faceCropLambdaArn: pulumi.Input<string>;
}): BotIdentityPolicy {
  const document = pulumi
    .all([args.tokenTableArn, args.browserSessionRoleArn, args.faceCropLambdaArn])
    .apply(([tokenTableArn, browserSessionRoleArn, faceCropLambdaArn]) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "RekognitionFaceVerification",
            Effect: "Allow",
            Action: [
              "rekognition:CompareFaces",
              "rekognition:CreateFaceLivenessSession",
              "rekognition:DetectFaces",
              "rekognition:GetFaceLivenessSessionResults",
            ],
            Resource: "*",
          },
          {
            Sid: "AssumeBrowserSessionRole",
            Effect: "Allow",
            Action: ["sts:AssumeRole"],
            Resource: browserSessionRoleArn,
          },
          {
            Sid: "WriteBootstrapTokens",
            Effect: "Allow",
            Action: ["dynamodb:PutItem"],
            Resource: tokenTableArn,
          },
          {
            Sid: "InvokeFaceCropLambda",
            Effect: "Allow",
            Action: ["lambda:InvokeFunction"],
            Resource: faceCropLambdaArn,
          },
        ],
      }),
    );

  const policy = new aws.iam.Policy("liveness-bot-policy", {
    name: `${args.resourcePrefix}-liveness-bot`,
    policy: document,
  });

  return {
    policy,
    document,
  };
}
