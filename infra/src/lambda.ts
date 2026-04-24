import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export type BootstrapLambda = {
  role: aws.iam.Role;
  policy: aws.iam.Policy;
  function: aws.lambda.Function;
};

export function createBootstrapLambda(args: {
  resourcePrefix: string;
  tokenTable: aws.dynamodb.Table;
  corsAllowOrigins: string[];
}): BootstrapLambda {
  const role = new aws.iam.Role("liveness-bootstrap-lambda-role", {
    name: `${args.resourcePrefix}-liveness-bootstrap-role`,
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
      Service: "lambda.amazonaws.com",
    }),
  });

  new aws.iam.RolePolicyAttachment("liveness-bootstrap-basic-execution", {
    role: role.name,
    policyArn: aws.iam.ManagedPolicies.AWSLambdaBasicExecutionRole,
  });

  const policy = new aws.iam.Policy("liveness-bootstrap-dynamodb-policy", {
    name: `${args.resourcePrefix}-liveness-bootstrap-dynamodb`,
    policy: pulumi.all([args.tokenTable.arn]).apply(([tableArn]) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["dynamodb:DeleteItem", "dynamodb:GetItem"],
            Resource: tableArn,
          },
        ],
      }),
    ),
  });

  new aws.iam.RolePolicyAttachment("liveness-bootstrap-dynamodb-attachment", {
    role: role.name,
    policyArn: policy.arn,
  });

  const fn = new aws.lambda.Function("liveness-bootstrap-function", {
    name: `${args.resourcePrefix}-liveness-bootstrap`,
    role: role.arn,
    runtime: aws.lambda.Runtime.NodeJS20dX,
    handler: "index.handler",
    timeout: 10,
    memorySize: 256,
    environment: {
      variables: {
        CORS_ALLOW_ORIGINS: args.corsAllowOrigins.join(","),
        TOKEN_TABLE_NAME: args.tokenTable.name,
      },
    },
    code: new pulumi.asset.AssetArchive({
      "index.mjs": new pulumi.asset.FileAsset(`${__dirname}/lambda/bootstrap/index.mjs`),
    }),
  });

  return {
    role,
    policy,
    function: fn,
  };
}
