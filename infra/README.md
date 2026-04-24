# Pulumi infra setup

This stack is intended to run against a DIY Pulumi backend, not Pulumi Cloud.

## Local backend

```bash
cd infra
mkdir -p .pulumi-state
pulumi login "file://$(pwd)/.pulumi-state"
pulumi stack init dev
```

## S3 backend

```bash
cd infra
pulumi login 's3://<bucket>/<prefix>?region=<aws-region>&awssdk=v2&profile=<aws-profile>'
pulumi stack init dev
```

## Required config

Set the required stack config after `pulumi stack init`:

```bash
pulumi config set aws:region eu-west-1
pulumi config set livenessPageBaseUrl https://kwikwag.github.io/trempiada/liveness
```

Optional overrides:

```bash
pulumi config set tokenTtlSeconds 180
pulumi config set --path 'corsAllowOrigins[0]' https://kwikwag.github.io
# optionally, for local testing
pulumi config set --path 'corsAllowOrigins[1]' http://localhost:5173
pulumi config set --path 'corsAllowOrigins[2]' http://127.0.0.1:5173
pulumi up
```

The generated stack file is `Pulumi.<stack>.yaml`. In that file, project-scoped keys are namespaced as `trempiada-liveness:<key>`, while provider keys keep their provider namespace such as `aws:region`.

## Cost estimation

There is a fast local estimator for the liveness stack:

```bash
cd infra
npm run estimate-costs
```

It does three things:

- reads the stack region from `Pulumi.<stack>.yaml` when possible
- reads resources from `pulumi preview --json --non-interactive` or from a saved preview file
- fetches only the needed regional AWS price-list files and caches them under `infra/.cache/aws-pricing/`

Default output includes:

- an `idle` monthly estimate
- reference usage points at `100`, `1,000`, and `10,000` liveness checks per month
- separate API Gateway, Lambda, DynamoDB, and Rekognition line items

Useful flags:

```bash
npm run estimate-costs -- --region eu-west-1
npm run estimate-costs -- --stack dev
npm run estimate-costs -- --preview-file sample-preview.json
npm run estimate-costs -- --lambda-ms 75 --success-rate 0.85
npm run estimate-costs -- --json
```

The estimator is intentionally opinionated around the current previewed stack:

- `1` HTTP API request per liveness attempt
- `1` Lambda invoke per attempt
- `1` DynamoDB read + `2` writes per attempt
- `1` Rekognition `StartFaceLivenessSession` per attempt
- `CompareFaces` cost gated by `--success-rate`

It also understands the specific AWS resource types already used here: `aws:dynamodb/table:Table`, `aws:lambda/function:Function`, `aws:apigatewayv2/api:Api`, plus the related zero-cost IAM, API route/stage/integration, and Lambda permission resources.
