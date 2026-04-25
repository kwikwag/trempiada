# Build for arm64 (Graviton) by default — cheaper and fast enough for CPU
# ONNX inference.  Override with --platform linux/amd64 if needed.
FROM public.ecr.aws/lambda/python:3.12

# DejaVu Sans for the watermark text
RUN dnf install -y dejavu-fonts-common dejavu-sans-fonts && dnf clean all

WORKDIR ${LAMBDA_TASK_ROOT}

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Download u2net_human_seg.onnx (~175 MB) at image-build time so the
# model is baked into the container and cold starts don't fetch anything.
# Source: rembg project (MIT-licensed weights, same preprocessing contract).
RUN python3 - <<'EOF'
import urllib.request, sys, hashlib
url = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net_human_seg.onnx"
dest = "u2net_human_seg.onnx"
print(f"Downloading {url} …", file=sys.stderr, flush=True)
urllib.request.urlretrieve(url, dest)
size = __import__("os").path.getsize(dest)
print(f"Saved {dest} ({size:,} bytes)", file=sys.stderr)
EOF

COPY handler.py .

CMD ["handler.handler"]
