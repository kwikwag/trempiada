import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export type BrowserSessionRole = {
  role: aws.iam.Role;
  policy: aws.iam.Policy;
};

export function createBrowserSessionRole(args: {
  resourcePrefix: string;
  trustedPrincipalArns: pulumi.Input<string[]>;
}): BrowserSessionRole {
  const role = new aws.iam.Role("liveness-browser-session-role", {
    name: `${args.resourcePrefix}-liveness-browser`,
    assumeRolePolicy: pulumi.output(args.trustedPrincipalArns).apply((trustedPrincipalArns) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: "sts:AssumeRole",
            Principal: {
              AWS: trustedPrincipalArns,
            },
          },
        ],
      }),
    ),
  });

  const policy = new aws.iam.Policy("liveness-browser-session-policy", {
    name: `${args.resourcePrefix}-liveness-browser`,
    policy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["rekognition:StartFaceLivenessSession"],
          Resource: "*",
        },
      ],
    }),
  });

  new aws.iam.RolePolicyAttachment("liveness-browser-session-policy-attachment", {
    role: role.name,
    policyArn: policy.arn,
  });

  return {
    role,
    policy,
  };
}
