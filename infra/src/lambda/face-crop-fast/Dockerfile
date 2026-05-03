# Build a Lambda container for either:
# - linux/amd64: x86_64 Lambda with the ORT U2Net backend
# - linux/arm64: arm64 Lambda with the tract-only backend
#
# Example:
#   docker build --platform=linux/amd64 --build-arg CARGO_FEATURES=ort-backend -t face-crop-fast:lambda .
#   docker build --platform=linux/arm64 -t face-crop-fast:lambda .

FROM --platform=$BUILDPLATFORM rust:1-slim-bookworm AS builder

ARG TARGETARCH
ARG CARGO_FEATURES=""

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates pkg-config libssl-dev patchelf \
    gcc-aarch64-linux-gnu libc6-dev-arm64-cross \
    && rm -rf /var/lib/apt/lists/*

RUN if [ "$TARGETARCH" = "arm64" ]; then rustup target add aarch64-unknown-linux-gnu; fi

ENV CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc

WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src

RUN set -eux; \
    feature_args=""; \
    if [ -n "$CARGO_FEATURES" ]; then feature_args="--features ${CARGO_FEATURES}"; fi; \
    if [ "$TARGETARCH" = "arm64" ]; then \
      cargo build --release --bin lambda --target aarch64-unknown-linux-gnu ${feature_args}; \
    elif [ "$TARGETARCH" = "amd64" ]; then \
      cargo build --release --bin lambda ${feature_args}; \
    else \
      echo "unsupported TARGETARCH=${TARGETARCH}" >&2; \
      exit 1; \
    fi

RUN mkdir -p /out && \
    if [ "$TARGETARCH" = "arm64" ]; then \
      build_dir=target/aarch64-unknown-linux-gnu/release; \
    else \
      build_dir=target/release; \
    fi && \
    patchelf --remove-rpath "$build_dir/lambda" && \
    cp "$build_dir/lambda" /out/bootstrap && \
    find "$build_dir" -maxdepth 1 -name 'libonnxruntime.so*' -exec cp {} /out/ \;

# ── Final Lambda image ───────────────────────────────────────────────────────
FROM --platform=$TARGETPLATFORM public.ecr.aws/lambda/provided:al2023

COPY --from=builder /out/ ${LAMBDA_RUNTIME_DIR}/

# Models baked into the image — no cold-start download, no S3 dependency.
COPY models/ultraface-rfb-320.onnx /var/task/models/ultraface-rfb-320.onnx
COPY models/u2netp.onnx            /var/task/models/u2netp.onnx

ENV LD_LIBRARY_PATH="${LAMBDA_RUNTIME_DIR}:${LD_LIBRARY_PATH}"

CMD ["bootstrap"]
