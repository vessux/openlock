FROM openlock-core:latest

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

RUN HOME=/root bash -c "curl -LsSf https://astral.sh/uv/install.sh | sh" \
    && mv /root/.local/bin/uv /usr/local/bin/ \
    && mv /root/.local/bin/uvx /usr/local/bin/

USER sandbox
WORKDIR /workspace
